import type { DownMessage, UpMessage } from '@cerebra/shared';
import type { Kysely } from 'kysely';
import { describe, expect, test } from 'vitest';

import type { Database } from './database.js';
import { EngineError } from './engine.js';
import { createFakeEngine, type FakeEngine } from './fake-engine.js';
import { hashRunToken, type RunnerListener } from './runner-gateway.js';
import { createRunStore, type RunRecord } from './runs.js';
import {
  AgentUnavailableError,
  createSupervisor,
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

interface Harness {
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
  options: Partial<SupervisorOptions> = {},
): Promise<void> {
  await withTestDatabase(async (database) => {
    const projectId = await registerTestProject(database);
    const engine = createFakeEngine();
    const runs = createRunStore(database);
    const logs: string[] = [];
    const prepared: string[] = [];
    const supervisor = createSupervisor({
      credentials: { resolveForRun: goodCredentials },
      database,
      engine,
      gatewayUrl: 'ws://main:4317/runner',
      log: (message) => logs.push(message),
      prepareDirectories: async (runId, agentId) => {
        prepared.push(`${runId} ${agentId}`);
      },
      runs,
      ...options,
    });
    await run({
      agent: (name) => agentNamed(database, projectId, name),
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
function up(event: UpMessage['event']): UpMessage {
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

describe('the run supervisor', { concurrent: false }, () => {
  test('starts an assistant in its own container with the token and gateway, never logging a secret', async () => {
    await withSupervisor(
      async ({ agent, engine, logs, prepared, runs, supervisor }) => {
        const agentId = await agent('Cerebro');

        const { runId } = await supervisor.start(agentId);

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

  test('a completed result finishes the run, removes its container and adds its cost', async () => {
    await withSupervisor(
      async ({ agent, connect, database, engine, runs, supervisor }) => {
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
        credentials: { resolveForRun: goodCredentials },
        database,
        endRetryMs: 1,
        engine: createFakeEngine(),
        gatewayUrl: 'ws://main:4317/runner',
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

  test('recovery after a restart fails every live run and removes its container', async () => {
    await withSupervisor(async ({ agent, database, engine, runs }) => {
      const agentId = await agent('Cerebro');
      const before = createSupervisor({
        credentials: { resolveForRun: goodCredentials },
        database,
        engine,
        gatewayUrl: 'ws://main:4317/runner',
        prepareDirectories: async () => {},
        runs,
      });
      const { runId } = await before.start(agentId);

      const after = createSupervisor({
        credentials: { resolveForRun: goodCredentials },
        database,
        engine,
        gatewayUrl: 'ws://main:4317/runner',
        prepareDirectories: async () => {},
        runs,
      });
      await after.recoverAfterRestart();

      expect(await runs.get(runId)).toMatchObject({
        failure: 'Cerebra restarted while the run was live.',
        state: 'failed',
      });
      expect(containerOf(engine, runId)).toBeUndefined();
    });
  });
});
