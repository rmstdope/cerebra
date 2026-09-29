import {
  maxFetchBytes,
  maxFetchPaths,
  type DownMessage,
  type EventMessage,
  type FilesMessage,
  type RunFile,
} from '@cerebra/shared';
import type { Kysely } from 'kysely';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { createBoard } from './board.js';
import { CheckoutError, type RunCheckouts } from './checkouts.js';
import type { Database } from './database.js';
import { createDispatcher } from './dispatcher.js';
import { EngineError } from './engine.js';
import { createFakeEngine, type FakeEngine } from './fake-engine.js';
import { hashRunToken, type RunnerListener } from './runner-gateway.js';
import { createRunStore, type RunRecord } from './runs.js';
import {
  AgentUnavailableError,
  createSupervisor,
  directoryPreparer,
  FileRequestError,
  RunEndedError,
  RunNotFoundError,
  RunStartError,
  type RunUpdate,
  type SupervisorOptions,
} from './supervisor.js';
import {
  agentNamed,
  registerTestProject,
  withTestDatabase,
} from './test-support.js';

type Resolve = SupervisorOptions['credentials']['resolveForRun'];

const goodCredentials: Resolve = async () => ({
  credentialIds: ['credential-1'],
  environment: { CLAUDE_CODE_OAUTH_TOKEN: 'secret-token' },
  files: [],
  ok: true,
});

/**
 * A fake of the run checkouts that records each call, and whether the run's container existed
 * when it was made: `create <run> <project> [container]`, `remove <run> [container]`, `sweep <live>`.
 */
function recordingCheckouts(
  engine: () => FakeEngine,
  calls: string[],
  overrides: Partial<RunCheckouts> = {},
): RunCheckouts {
  const container = (runId: string) =>
    containerOf(engine(), runId) === undefined ? 'no container' : 'container';
  return {
    async create(input) {
      calls.push(
        `create ${input.runId} ${input.projectId} ${container(input.runId)}`,
      );
      await overrides.create?.(input);
    },
    async remove(runId) {
      calls.push(`remove ${runId} ${container(runId)}`);
      await overrides.remove?.(runId);
    },
    async sweep(live) {
      calls.push(`sweep ${[...live].join(',')}`);
      await overrides.sweep?.(live);
    },
  };
}

interface Harness {
  readonly checkouts: string[];
  readonly database: Kysely<Database>;
  readonly engine: FakeEngine;
  readonly logs: string[];
  readonly prepared: string[];
  readonly projectId: string;
  readonly runs: ReturnType<typeof createRunStore>;
  readonly supervisor: ReturnType<typeof createSupervisor>;
  agent(name: string): Promise<string>;
  /** Connects a runner the way the gateway would, answering what it was sent. */
  connect(runId: string): Promise<{
    readonly sent: DownMessage[];
    readonly listener: RunnerListener;
    closed(): boolean;
  }>;
}

async function withSupervisor(
  run: (harness: Harness) => Promise<void>,
  options: Partial<SupervisorOptions> & {
    readonly checkoutsDoing?: Partial<RunCheckouts>;
  } = {},
): Promise<void> {
  const { checkoutsDoing, ...supervisorOptions } = options;
  await withTestDatabase(async (database) => {
    const projectId = await registerTestProject(database);
    const engine = createFakeEngine();
    const runs = createRunStore(database);
    const logs: string[] = [];
    const prepared: string[] = [];
    const checkouts: string[] = [];
    const supervisor = createSupervisor({
      checkouts: recordingCheckouts(() => engine, checkouts, checkoutsDoing),
      credentials: { resolveForRun: goodCredentials },
      database,
      engine,
      gatewayUrl: 'ws://main:4317/runner',
      mcpUrl: 'http://main:4317/mcp',
      log: (message) => logs.push(message),
      prepareDirectories: async (runId, agentId) => {
        prepared.push(`${runId} ${agentId}`);
      },
      runs,
      ...supervisorOptions,
    });
    await run({
      agent: (name) => agentNamed(database, projectId, name),
      checkouts,
      async connect(runId) {
        const token = engine.requestFor(`cerebra-run-${runId}`)?.body.Env;
        const hash = hashRunToken(tokenOf(token));
        const record = await supervisor.gateway.authenticate(hash);
        expect(record?.id).toBe(runId);
        const sent: DownMessage[] = [];
        let closed = false;
        const listener = supervisor.gateway.accept({
          close: () => {
            closed = true;
          },
          run: record as RunRecord,
          send: (message) => sent.push(message),
        });
        return { closed: () => closed, listener, sent };
      },
      database,
      engine,
      logs,
      prepared,
      projectId,
      runs,
      supervisor,
    });
  });
}

function tokenOf(environment: readonly string[] | undefined): string {
  const entry = environment?.find((line) =>
    line.startsWith('CEREBRA_RUN_TOKEN='),
  );
  if (entry === undefined) throw new Error('The container has no run token.');
  return entry.slice('CEREBRA_RUN_TOKEN='.length);
}

function containerOf(engine: FakeEngine, runId: string) {
  return engine.requestFor(`cerebra-run-${runId}`);
}

let seq = 0;
function up(event: EventMessage['event']): EventMessage {
  seq += 1;
  return { event, seq, type: 'event' };
}

/** Lets the supervisor finish the work a message queued. */
async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const usage = { costUsd: 0.25, models: {} };

/** A container an earlier run of the agent left behind, as a crash or a failed removal would. */
async function leftover(engine: FakeEngine, agentId: string, runId: string) {
  const { id } = await engine.create({
    agentId,
    environment: {},
    image: 'cerebro-agent',
    resources: { cpus: 1, memoryBytes: 1024 },
    runId,
  });
  await engine.start(id);
  return id;
}

/** The volume subpath mounted at each target of a run's container. */
function mountsOf(engine: FakeEngine, runId: string): Record<string, string> {
  return Object.fromEntries(
    (containerOf(engine, runId)?.body.HostConfig.Mounts ?? []).map((mount) => [
      mount.Target,
      mount.VolumeOptions.Subpath,
    ]),
  );
}

describe('the run supervisor', { concurrent: false }, () => {
  test('starts an assistant in its own container with the token and gateway, never logging a secret', async () => {
    await withSupervisor(
      async ({
        agent,
        checkouts,
        engine,
        logs,
        prepared,
        projectId,
        runs,
        supervisor,
      }) => {
        const agentId = await agent('Cerebro');

        const { runId } = await supervisor.start(agentId);

        expect(checkouts).toEqual([
          `create ${runId} ${projectId} no container`,
        ]);
        const request = engine.requestFor(`cerebra-run-${runId}`);
        expect(request?.body.Image).toBe('cerebro-agent');
        expect(request?.body.Env).toEqual(
          expect.arrayContaining([
            'CLAUDE_CODE_OAUTH_TOKEN=secret-token',
            'CEREBRA_GATEWAY_URL=ws://main:4317/runner',
            expect.stringMatching(/^CEREBRA_RUN_TOKEN=.+/),
          ]),
        );
        expect(prepared).toEqual([`${runId} ${agentId}`]);
        const run = await runs.get(runId);
        expect(run).toMatchObject({
          agentId,
          role: 'assistant',
          state: 'starting',
        });
        expect(run?.containerId).not.toBeNull();
        expect((await engine.inspect(run?.containerId ?? ''))?.status).toBe(
          'running',
        );
        expect(logs.join('\n')).not.toContain('secret-token');
      },
    );
  });

  test('refuses a turned-off agent, a non-interactive one, and a second live run', async () => {
    await withSupervisor(async ({ agent, database, supervisor }) => {
      const cerebro = await agent('Cerebro');
      const storm = await agent('Storm');
      await database
        .updateTable('agents')
        .set({ enabled: false })
        .where('id', '=', cerebro)
        .execute();
      await expect(supervisor.start(cerebro)).rejects.toMatchObject({
        code: 'disabled',
      });
      await database
        .updateTable('agents')
        .set({ enabled: true })
        .where('id', '=', cerebro)
        .execute();

      await expect(supervisor.start(storm)).rejects.toMatchObject({
        code: 'not_interactive',
      });
      await supervisor.start(cerebro);
      await expect(supervisor.start(cerebro)).rejects.toBeInstanceOf(
        AgentUnavailableError,
      );
      await expect(supervisor.start(crypto.randomUUID())).rejects.toMatchObject(
        { name: 'AgentNotFoundError' },
      );
    });
  });

  test('missing credentials fail the start and leave nothing running', async () => {
    await withSupervisor(
      async ({ agent, engine, runs, supervisor }) => {
        const agentId = await agent('Cerebro');

        const failure = await supervisor.start(agentId).catch((error) => error);

        expect(failure).toBeInstanceOf(RunStartError);
        expect(failure.message).toBe('Cerebro couldn’t start.');
        const run = await runs.get((failure as RunStartError).runId);
        expect(run).toMatchObject({ startFailed: true, state: 'failed' });
        expect(run?.failure).toContain('CLAUDE_CODE_OAUTH_TOKEN');
        expect(containerOf(engine, failure.runId)).toBeUndefined();
        expect(await runs.liveFor(agentId)).toBeNull();
      },
      {
        credentials: {
          resolveForRun: async () => ({
            ok: false,
            problems: [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', reason: 'missing' }],
          }),
        },
      },
    );
  });

  test('an engine that cannot start the container fails the start and removes it', async () => {
    await withSupervisor(async ({ agent, engine, runs, supervisor }) => {
      const agentId = await agent('Cerebro');
      engine.failNext('start', new EngineError('start', 'No such image.'));

      const failure = await supervisor.start(agentId).catch((error) => error);

      expect(failure).toBeInstanceOf(RunStartError);
      expect(await runs.get(failure.runId)).toMatchObject({
        failure: 'No such image.',
        startFailed: true,
        state: 'failed',
      });
      expect(containerOf(engine, failure.runId)).toBeUndefined();
    });
  });

  test('a runner starts with the board tools, reached with its own run token', async () => {
    await withSupervisor(async ({ agent, connect, engine, supervisor }) => {
      const { runId } = await supervisor.start(await agent('Cerebro'));

      const runner = await connect(runId);

      const token = tokenOf(containerOf(engine, runId)?.body.Env);
      expect(runner.sent[0]).toMatchObject({
        mcpServers: {
          cerebra: {
            headers: { Authorization: `Bearer ${token}` },
            type: 'http',
            url: 'http://main:4317/mcp',
          },
        },
        type: 'start',
      });
    });
  });

  test('a connecting runner gets its start, then every message sent before it connected', async () => {
    await withSupervisor(async ({ agent, connect, database, supervisor }) => {
      const agentId = await agent('Cerebro');
      const projectId = (
        await database
          .selectFrom('agents')
          .select('project_id')
          .where('id', '=', agentId)
          .executeTakeFirstOrThrow()
      ).project_id;
      const typeId = (
        await database
          .selectFrom('agent_types')
          .select('id')
          .where('role', '=', 'assistant')
          .executeTakeFirstOrThrow()
      ).id;
      await database
        .insertInto('agent_type_overrides')
        .values({
          agent_type_id: typeId,
          fields: JSON.stringify({ model: 'sonnet' }) as never,
          project_id: projectId,
        })
        .execute();
      const { runId } = await supervisor.start(agentId);
      await supervisor.send(runId, 'Hello');

      const runner = await connect(runId);

      expect(runner.sent[0]).toMatchObject({
        effort: 'high',
        firstMessage: '',
        interactive: true,
        model: 'sonnet',
        resumeSessionId: null,
        type: 'start',
      });
      expect(
        (runner.sent[0] as { instructions: string }).instructions,
      ).toContain("You are the project's assistant");
      expect(runner.sent.slice(1)).toEqual([
        { text: 'Hello', type: 'user_message' },
      ]);

      await supervisor.answer(runId, 'q-1', { Which: 'This one' });
      expect(runner.sent.at(-1)).toEqual({
        answers: { Which: 'This one' },
        questionId: 'q-1',
        type: 'answer',
      });
    });
  });

  test('records events in order, follows the runner’s status and tells subscribers', async () => {
    await withSupervisor(async ({ agent, connect, runs, supervisor }) => {
      const { runId } = await supervisor.start(await agent('Cerebro'));
      const updates: RunUpdate[] = [];
      const unsubscribe = supervisor.subscribe(runId, (update) =>
        updates.push(update),
      );
      const runner = await connect(runId);

      runner.listener.message(up({ kind: 'status', status: 'awaiting_input' }));
      runner.listener.message(up({ kind: 'user_message', text: 'Hi' }));
      runner.listener.message(up({ kind: 'status', status: 'active' }));
      runner.listener.message(up({ kind: 'message', text: 'Hello!' }));
      runner.listener.message(
        up({ end: 'turn', kind: 'result', sessionId: 'session-1', usage }),
      );
      await settle();

      expect((await runs.get(runId))?.state).toBe('active');
      const conversation = await runs.read(runId);
      expect(conversation?.events.map((record) => record.event.kind)).toEqual([
        'status',
        'user_message',
        'status',
        'message',
        'result',
      ]);
      expect(
        updates
          .filter((update) => update.type === 'state')
          .map((update) => update.type === 'state' && update.state),
      ).toEqual(['awaiting_input', 'active']);
      expect(updates.filter((update) => update.type === 'event')).toHaveLength(
        5,
      );

      unsubscribe();
      runner.listener.message(up({ kind: 'message', text: 'Unheard' }));
      await settle();
      expect(updates).toHaveLength(7);
    });
  });

  test('a completed result finishes the run, removes its container, then its checkout, and adds its cost', async () => {
    await withSupervisor(
      async ({
        agent,
        checkouts,
        connect,
        database,
        engine,
        runs,
        supervisor,
      }) => {
        const { runId } = await supervisor.start(await agent('Cerebro'));
        const runner = await connect(runId);

        runner.listener.message(up({ end: 'turn', kind: 'result', usage }));
        runner.listener.message(
          up({ end: 'completed', kind: 'result', usage }),
        );
        await settle();

        expect((await runs.get(runId))?.state).toBe('finished');
        expect(runner.closed()).toBe(true);
        expect(containerOf(engine, runId)).toBeUndefined();
        expect(checkouts.at(-1)).toBe(`remove ${runId} no container`);
        const row = await database
          .selectFrom('runs')
          .select('cost_usd')
          .where('id', '=', runId)
          .executeTakeFirstOrThrow();
        expect(row.cost_usd).toBe(0.5);
        await expect(supervisor.send(runId, 'More?')).rejects.toBeInstanceOf(
          RunEndedError,
        );
        expect(await supervisor.gateway.authenticate('any')).toBeNull();
      },
    );
  });

  test('a failed result or a runner that goes away without one fails the run', async () => {
    await withSupervisor(async ({ agent, connect, runs, supervisor }) => {
      const first = await supervisor.start(await agent('Cerebro'));
      const firstRunner = await connect(first.runId);
      firstRunner.listener.message(
        up({ end: 'failed', error: 'Claude crashed.', kind: 'result', usage }),
      );
      await settle();
      expect(await runs.get(first.runId)).toMatchObject({
        failure: 'Claude crashed.',
        state: 'failed',
      });

      const second = await supervisor.start(await agent('Cerebro'));
      const secondRunner = await connect(second.runId);
      secondRunner.listener.closed({ code: 1006 });
      await settle();
      expect(await runs.get(second.runId)).toMatchObject({
        failure: 'The runner disconnected.',
        startFailed: false,
        state: 'failed',
      });
    });
  });

  test('a runner that never connects fails the run after the timeout', async () => {
    await withSupervisor(
      async ({ agent, engine, runs, supervisor }) => {
        const { runId } = await supervisor.start(await agent('Cerebro'));
        await new Promise((resolve) => setTimeout(resolve, 80));
        await settle();

        expect(await runs.get(runId)).toMatchObject({
          failure: 'The runner did not connect in time.',
          state: 'failed',
        });
        expect(containerOf(engine, runId)).toBeUndefined();
      },
      { connectTimeoutMs: 20 },
    );
  });

  test('stopping sends stop to a connected runner, and ends one that never connected', async () => {
    await withSupervisor(async ({ agent, connect, runs, supervisor }) => {
      const cerebroId = await agent('Cerebro');
      const first = await supervisor.start(cerebroId);
      const runner = await connect(first.runId);

      await supervisor.stop(cerebroId);
      expect(runner.sent.at(-1)).toEqual({ type: 'stop' });
      runner.listener.message(up({ end: 'stopped', kind: 'result', usage }));
      await settle();
      expect((await runs.get(first.runId))?.state).toBe('finished');

      const second = await supervisor.start(cerebroId);
      await supervisor.stopRun(second.runId);
      expect((await runs.get(second.runId))?.state).toBe('finished');
      await supervisor.stopRun(second.runId);
      await expect(
        supervisor.stopRun(crypto.randomUUID()),
      ).rejects.toBeInstanceOf(RunNotFoundError);
      await expect(supervisor.send('nope', 'Hi')).rejects.toBeInstanceOf(
        RunNotFoundError,
      );
    });
  });

  test('a run stopped while its container is being made leaves no container behind', async () => {
    let release: () => void = () => undefined;
    const prepared = new Promise<void>((resolve) => {
      release = resolve;
    });
    await withSupervisor(
      async ({ agent, engine, runs, supervisor }) => {
        const cerebroId = await agent('Cerebro');
        const starting = supervisor.start(cerebroId);
        await settle();
        const live = await runs.liveFor(cerebroId);
        expect(live).not.toBeNull();

        await supervisor.stop(cerebroId);
        release();
        const { runId } = await starting;

        expect(runId).toBe(live?.id);
        expect((await runs.get(runId))?.state).toBe('finished');
        expect(containerOf(engine, runId)).toBeUndefined();
      },
      { prepareDirectories: () => prepared },
    );
  });

  test('a container that cannot be stopped is still removed', async () => {
    await withSupervisor(async ({ agent, engine, runs, supervisor }) => {
      const cerebroId = await agent('Cerebro');
      engine.failNext('start', new EngineError('start', 'No room.'));
      engine.failNext('stop', new EngineError('stop', 'Already gone.'));

      const failure = await supervisor.start(cerebroId).catch((e) => e);

      expect(failure).toBeInstanceOf(RunStartError);
      const runId = (failure as RunStartError).runId;
      expect((await runs.get(runId))?.state).toBe('failed');
      expect(containerOf(engine, runId)).toBeUndefined();
    });
  });

  test('an ending the database refuses at first is retried until it is recorded', async () => {
    await withTestDatabase(async (database) => {
      const projectId = await registerTestProject(database);
      const store = createRunStore(database);
      let refusals = 1;
      const runs: typeof store = {
        ...store,
        end: async (runId, ending) => {
          if (refusals > 0) {
            refusals -= 1;
            throw new Error('connection reset');
          }
          return store.end(runId, ending);
        },
      };
      const supervisor = createSupervisor({
        checkouts: recordingCheckouts(() => createFakeEngine(), []),
        credentials: { resolveForRun: goodCredentials },
        database,
        endRetryMs: 1,
        engine: createFakeEngine(),
        gatewayUrl: 'ws://main:4317/runner',
        mcpUrl: 'http://main:4317/mcp',
        prepareDirectories: async () => undefined,
        runs,
      });
      const cerebroId = await agentNamed(database, projectId, 'Cerebro');
      const { runId } = await supervisor.start(cerebroId);

      await supervisor.stopRun(runId);

      expect((await store.get(runId))?.state).toBe('finished');
      await expect(supervisor.send(runId, 'Hi')).rejects.toBeInstanceOf(
        RunEndedError,
      );
    });
  });

  test('recovery after a restart fails every live run, removes its container and checkout, and sweeps the rest', async () => {
    await withSupervisor(async ({ agent, database, engine, runs }) => {
      const agentId = await agent('Cerebro');
      const calls: string[] = [];
      const before = createSupervisor({
        checkouts: recordingCheckouts(() => engine, []),
        credentials: { resolveForRun: goodCredentials },
        database,
        engine,
        gatewayUrl: 'ws://main:4317/runner',
        mcpUrl: 'http://main:4317/mcp',
        prepareDirectories: async () => {},
        runs,
      });
      const { runId } = await before.start(agentId);

      const after = createSupervisor({
        checkouts: recordingCheckouts(() => engine, calls),
        credentials: { resolveForRun: goodCredentials },
        database,
        engine,
        gatewayUrl: 'ws://main:4317/runner',
        mcpUrl: 'http://main:4317/mcp',
        prepareDirectories: async () => {},
        runs,
      });
      await after.recoverAfterRestart();

      expect(await runs.get(runId)).toMatchObject({
        failure: 'Cerebra restarted while the run was live.',
        state: 'failed',
      });
      expect(containerOf(engine, runId)).toBeUndefined();
      expect(calls).toEqual([`remove ${runId} no container`, 'sweep ']);
    });
  });

  test('a checkout that cannot be made fails the start with its reason and makes no container', async () => {
    await withSupervisor(
      async ({ agent, checkouts, engine, prepared, runs, supervisor }) => {
        const failure = await supervisor
          .start(await agent('Cerebro'))
          .catch((error) => error);

        expect(failure).toBeInstanceOf(RunStartError);
        const runId = (failure as RunStartError).runId;
        expect(await runs.get(runId)).toMatchObject({
          failure: 'The branch main is not on GitHub.',
          startFailed: true,
          state: 'failed',
        });
        expect(containerOf(engine, runId)).toBeUndefined();
        expect(prepared).toEqual([]);
        expect(checkouts.at(-1)).toBe(`remove ${runId} no container`);
      },
      {
        checkoutsDoing: {
          create: async () => {
            throw new CheckoutError('The branch main is not on GitHub.');
          },
        },
      },
    );
  });

  test('a run stopped while its checkout is being made has the checkout removed once it is made', async () => {
    let release: () => void = () => undefined;
    const made = new Promise<void>((resolve) => {
      release = resolve;
    });
    await withSupervisor(
      async ({ agent, checkouts, engine, runs, supervisor }) => {
        const cerebroId = await agent('Cerebro');
        const starting = supervisor.start(cerebroId);
        await settle();

        await supervisor.stop(cerebroId);
        release();
        const { runId } = await starting;

        expect((await runs.get(runId))?.state).toBe('finished');
        expect(containerOf(engine, runId)).toBeUndefined();
        expect(checkouts.at(-1)).toBe(`remove ${runId} no container`);
        expect(
          checkouts.filter((call) => call.startsWith('remove')),
        ).toHaveLength(2);
      },
      { checkoutsDoing: { create: () => made } },
    );
  });

  test('a checkout that cannot be removed is logged, and the run still ends', async () => {
    await withSupervisor(
      async ({ agent, logs, runs, supervisor }) => {
        const { runId } = await supervisor.start(await agent('Cerebro'));

        await supervisor.stopRun(runId);

        expect((await runs.get(runId))?.state).toBe('finished');
        expect(logs).toContain(
          `Run ${runId}: its checkout could not be removed: Device busy.`,
        );
      },
      {
        checkoutsDoing: {
          remove: async () => {
            throw new Error('Device busy.');
          },
        },
      },
    );
  });
});

const page: RunFile = {
  content: Buffer.from('<h1>Hi</h1>').toString('base64'),
  contentType: 'text/html; charset=utf-8',
  path: 'mockups/home.html',
};

function fetchRequest(sent: readonly DownMessage[]) {
  const request = sent.at(-1);
  if (request?.type !== 'fetch_files') {
    throw new Error('The runner was not asked for files.');
  }
  return request;
}

describe('fetching files from a run’s checkout', { concurrent: false }, () => {
  test('asks the runner for the paths and answers what it sends back', async () => {
    await withSupervisor(async ({ agent, connect, supervisor }) => {
      const { runId } = await supervisor.start(await agent('Cerebro'));
      const runner = await connect(runId);

      const fetching = supervisor.fetchFiles(runId, ['mockups/home.html']);
      await settle();
      const request = fetchRequest(runner.sent);
      expect(request.paths).toEqual(['mockups/home.html']);
      runner.listener.message({
        files: [{ ...page, path: 'mockups/other.html' }],
        requestId: crypto.randomUUID(),
        type: 'files',
      } satisfies FilesMessage);
      runner.listener.message({
        files: [page],
        requestId: request.requestId,
        type: 'files',
      } satisfies FilesMessage);

      await expect(fetching).resolves.toEqual([page]);
    });
  });

  test('passes on the runner’s refusal', async () => {
    await withSupervisor(async ({ agent, connect, supervisor }) => {
      const { runId } = await supervisor.start(await agent('Cerebro'));
      const runner = await connect(runId);

      const fetching = supervisor.fetchFiles(runId, ['../secret']);
      await settle();
      runner.listener.message({
        error: 'The path ../secret is outside the checkout.',
        requestId: fetchRequest(runner.sent).requestId,
        type: 'files',
      });

      await expect(fetching).rejects.toThrow(
        new FileRequestError('The path ../secret is outside the checkout.'),
      );
    });
  });

  test('refuses an answer that is not the files asked for', async () => {
    await withSupervisor(async ({ agent, connect, supervisor }) => {
      const { runId } = await supervisor.start(await agent('Cerebro'));
      const runner = await connect(runId);

      const fetching = supervisor.fetchFiles(runId, ['mockups/home.html']);
      await settle();
      runner.listener.message({
        files: [{ ...page, path: 'mockups/other.html' }],
        requestId: fetchRequest(runner.sent).requestId,
        type: 'files',
      });

      await expect(fetching).rejects.toThrow(
        new FileRequestError(
          'The runner answered with other files than asked for.',
        ),
      );
    });
  });

  test('refuses an answer larger than the files may come to', async () => {
    await withSupervisor(async ({ agent, connect, supervisor }) => {
      const { runId } = await supervisor.start(await agent('Cerebro'));
      const runner = await connect(runId);

      const fetching = supervisor.fetchFiles(runId, ['mockups/home.html']);
      await settle();
      runner.listener.message({
        files: [
          {
            ...page,
            content: Buffer.alloc(maxFetchBytes + 1).toString('base64'),
          },
        ],
        requestId: fetchRequest(runner.sent).requestId,
        type: 'files',
      });

      await expect(fetching).rejects.toThrow(
        new FileRequestError(
          'The runner answered with more than the files may come to.',
        ),
      );
    });
  });

  test('refuses no paths, or more than a request may carry, without asking the runner', async () => {
    await withSupervisor(async ({ agent, connect, runs, supervisor }) => {
      const { runId } = await supervisor.start(await agent('Cerebro'));
      const runner = await connect(runId);
      const tooMany = Array.from(
        { length: maxFetchPaths + 1 },
        (_, index) => `mockups/${index}.html`,
      );

      await expect(supervisor.fetchFiles(runId, [])).rejects.toThrow(
        new FileRequestError('Name at least one file to fetch.'),
      );
      await expect(supervisor.fetchFiles(runId, tooMany)).rejects.toThrow(
        new FileRequestError(
          `At most ${maxFetchPaths} files can be fetched at once.`,
        ),
      );
      expect(
        runner.sent.some((message) => message.type === 'fetch_files'),
      ).toBe(false);
      expect((await runs.get(runId))?.endedAt).toBeNull();
    });
  });

  test('gives up on a runner that does not answer in time', async () => {
    await withSupervisor(
      async ({ agent, connect, supervisor }) => {
        const { runId } = await supervisor.start(await agent('Cerebro'));
        await connect(runId);

        await expect(
          supervisor.fetchFiles(runId, ['mockups/home.html']),
        ).rejects.toThrow(
          new FileRequestError('The run did not send the files in time.'),
        );
      },
      { fileRequestTimeoutMs: 20 },
    );
  });

  test('stops waiting when the run ends, and refuses an ended run', async () => {
    await withSupervisor(async ({ agent, connect, supervisor }) => {
      const { runId } = await supervisor.start(await agent('Cerebro'));
      const runner = await connect(runId);

      const fetching = supervisor.fetchFiles(runId, ['mockups/home.html']);
      await settle();
      fetchRequest(runner.sent);
      const ending = expect(fetching).rejects.toBeInstanceOf(RunEndedError);
      runner.listener.closed({ code: 1006 });

      await ending;
      await expect(
        supervisor.fetchFiles(runId, ['mockups/home.html']),
      ).rejects.toBeInstanceOf(RunEndedError);
      await expect(
        supervisor.fetchFiles(crypto.randomUUID(), ['a']),
      ).rejects.toBeInstanceOf(RunNotFoundError);
    });
  });
  test("a start removes every container an earlier run of the same agent left behind, and no other agent's", async () => {
    await withSupervisor(async ({ agent, engine, supervisor }) => {
      const cerebroId = await agent('Cerebro');
      const stormId = await agent('Storm');
      const stale = await leftover(engine, cerebroId, 'stale-run');
      const created = await engine.create({
        agentId: cerebroId,
        environment: {},
        image: 'cerebro-agent',
        resources: { cpus: 1, memoryBytes: 1024 },
        runId: 'never-started',
      });
      const storms = await leftover(engine, stormId, 'storm-run');

      const { runId } = await supervisor.start(cerebroId);

      expect(await engine.inspect(stale)).toBeNull();
      expect(await engine.inspect(created.id)).toBeNull();
      expect((await engine.inspect(storms))?.status).toBe('running');
      const current = containerOf(engine, runId);
      expect(await engine.containersOf(cerebroId)).toHaveLength(1);
      expect(current).toBeDefined();
    });
  });

  test.each([
    ['listed', 'list'],
    ['removed', 'remove'],
  ] as const)(
    'a start fails and creates nothing when an earlier container cannot be %s',
    async (_verb, operation) => {
      await withSupervisor(async ({ agent, engine, runs, supervisor }) => {
        const cerebroId = await agent('Cerebro');
        const stale = await leftover(engine, cerebroId, 'stale-run');
        engine.failNext(operation, new EngineError(operation, 'Engine busy.'));

        const failure = await supervisor.start(cerebroId).catch((e) => e);

        expect(failure).toBeInstanceOf(RunStartError);
        const runId = (failure as RunStartError).runId;
        expect(await runs.get(runId)).toMatchObject({
          failure: expect.stringContaining(
            'An earlier container of this agent is still there',
          ),
          state: 'failed',
        });
        expect(containerOf(engine, runId)).toBeUndefined();
        expect(await engine.containersOf(cerebroId)).toEqual([stale]);
      });
    },
  );

  test('successive runs of an agent mount the same home and CLI state, each with its own checkout', async () => {
    await withSupervisor(async ({ agent, engine, supervisor }) => {
      const cerebroId = await agent('Cerebro');
      const first = await supervisor.start(cerebroId);
      const firstMounts = mountsOf(engine, first.runId);
      await supervisor.stopRun(first.runId);

      const second = await supervisor.start(cerebroId);
      const secondMounts = mountsOf(engine, second.runId);

      expect(firstMounts).toEqual({
        '/cli-state': `agents/${cerebroId}/cli-state`,
        '/home/agent': `agents/${cerebroId}/home`,
        '/work': `runs/${first.runId}/checkout`,
      });
      expect(secondMounts).toEqual({
        ...firstMounts,
        '/work': `runs/${second.runId}/checkout`,
      });
    });
  });

  test('no two agents share a mount, in one project or across projects', async () => {
    await withSupervisor(async ({ agent, database, engine, supervisor }) => {
      const otherProject = await registerTestProject(database, 'shop');
      const agentIds = [
        await agent('Cerebro'),
        await agentNamed(database, otherProject, 'Cerebro'),
      ];
      expect(new Set(agentIds).size).toBe(2);

      const subpaths: string[] = [];
      for (const agentId of agentIds) {
        const { runId } = await supervisor.start(agentId);
        subpaths.push(...Object.values(mountsOf(engine, runId)));
      }

      expect(subpaths).toHaveLength(6);
      expect(new Set(subpaths).size).toBe(6);
    });
  });

  test('concurrent starts of one agent give it one live run and one container', async () => {
    await withSupervisor(async ({ agent, engine, runs, supervisor }) => {
      const cerebroId = await agent('Cerebro');

      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, () => supervisor.start(cerebroId)),
      );

      const started = outcomes.filter(
        (outcome) => outcome.status === 'fulfilled',
      );
      const refused = outcomes.filter(
        (outcome) => outcome.status === 'rejected',
      );
      expect(started).toHaveLength(1);
      for (const outcome of refused) {
        expect(outcome.reason).toMatchObject({ code: 'already_running' });
      }
      expect((await runs.live()).map((run) => run.agentId)).toEqual([
        cerebroId,
      ]);
      expect(await engine.containersOf(cerebroId)).toHaveLength(1);
    });
  });
});

describe('runs the dispatcher starts', { concurrent: false }, () => {
  async function dispatchOne(harness: Harness): Promise<string> {
    const itemId = crypto.randomUUID();
    await createBoard(harness.database).createWorkItem({
      description: 'Exports time out after a minute.',
      id: itemId,
      priority: 'P1',
      projectId: harness.projectId,
      state: 'build_ready',
      title: 'Fix export timeout',
    });
    await createDispatcher({
      credentials: { problemsFor: async () => [] },
      database: harness.database,
      launch: (run) => harness.supervisor.launchDispatched(run),
    }).dispatch();
    return itemId;
  }

  test('a dispatched run starts on its own, told which item it holds', async () => {
    await withSupervisor(async (harness) => {
      await dispatchOne(harness);
      const [run] = await harness.runs.live();

      const runner = await harness.connect(run.id);

      expect(run).toMatchObject({
        agentId: await harness.agent('Cyclops'),
        role: 'builder',
      });
      expect(runner.sent[0]).toMatchObject({
        firstMessage: 'Fix export timeout\n\nExports time out after a minute.',
        interactive: false,
        type: 'start',
      });
    });
  });

  test('a dispatched run that cannot start fails and gives its item back', async () => {
    await withSupervisor(async (harness) => {
      harness.engine.failNext(
        'start',
        new EngineError('start', 'No such image.'),
      );

      const itemId = await dispatchOne(harness);

      expect(await harness.runs.live()).toEqual([]);
      const item = await harness.database
        .selectFrom('work_items')
        .select(['state', 'attempts', 'holder_run_id'])
        .where('id', '=', itemId)
        .executeTakeFirstOrThrow();
      expect(item).toEqual({
        attempts: 1,
        holder_run_id: null,
        state: 'build_ready',
      });
      expect(harness.logs.join('\n')).toContain('No such image.');
    });
  });

  test('every run that ends is reported, so waiting work can start', async () => {
    const ended: string[] = [];
    await withSupervisor(
      async ({ agent, supervisor }) => {
        const agentId = await agent('Cerebro');
        const { runId } = await supervisor.start(agentId);

        await supervisor.stop(agentId);

        expect(ended).toEqual([runId]);
      },
      { onRunEnded: (runId) => ended.push(runId) },
    );
  });
});

describe("an agent's directories", () => {
  test('a later run of an agent finds what an earlier run left in its home and CLI state', async () => {
    const data = await mkdtemp(join(tmpdir(), 'cerebra-data-'));
    try {
      const prepare = directoryPreparer(data);
      await prepare('run-1', 'agent-1');
      await writeFile(join(data, 'agents/agent-1/home/notes'), 'remembered');
      await writeFile(
        join(data, 'agents/agent-1/cli-state/.claude.json'),
        '{"memory":true}',
      );

      await prepare('run-2', 'agent-1');
      await prepare('run-3', 'agent-2');

      expect(
        await readFile(join(data, 'agents/agent-1/home/notes'), 'utf8'),
      ).toBe('remembered');
      expect(
        await readFile(
          join(data, 'agents/agent-1/cli-state/.claude.json'),
          'utf8',
        ),
      ).toBe('{"memory":true}');
      await expect(
        readFile(join(data, 'agents/agent-2/home/notes'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        readFile(join(data, 'runs/run-2/checkout/notes'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(data, { force: true, recursive: true });
    }
  });
});
