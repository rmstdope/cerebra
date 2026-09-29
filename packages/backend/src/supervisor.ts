import { mkdir, chown } from 'node:fs/promises';
import { join } from 'node:path';

import {
  maxFetchBytes,
  maxFetchPaths,
  type AgentEvent,
  type Answers,
  type DownMessage,
  type FilesMessage,
  type RunFile,
  type StartMessage,
  type UpMessage,
} from '@cerebra/shared';
import type { Kysely } from 'kysely';

import type { AgentRole } from './agent-types.js';
import type { RunCheckouts } from './checkouts.js';
import type { CredentialService } from './credentials.js';
import type { Database, RunState } from './database.js';
import { ContainerNotFoundError, type ContainerEngine } from './engine.js';
import { AgentNotFoundError, type RunControl } from './fleet.js';
import {
  createRunToken,
  type RunnerConnection,
  type RunnerGatewayOptions,
  type RunnerListener,
} from './runner-gateway.js';
import {
  isUuid,
  type Conversation,
  type EndRun,
  type RunEventRecord,
  type RunRecord,
  type RunStore,
} from './runs.js';

/** What a subscriber to one run hears: each recorded event, and each change of state. */
export type RunUpdate =
  | ({ readonly type: 'event' } & RunEventRecord)
  | {
      readonly type: 'state';
      readonly state: RunState;
      readonly failure: string | null;
    };

export interface Supervisor extends RunControl {
  start(agentId: string): Promise<{ readonly runId: string }>;
  /** Starts a run the dispatcher inserted and claimed an item for (architecture §6). */
  launchDispatched(run: {
    readonly agentId: string;
    readonly firstMessage: string;
    readonly runId: string;
    readonly token: string;
  }): Promise<void>;
  read(runId: string): Promise<Conversation | null>;
  send(runId: string, text: string): Promise<void>;
  answer(runId: string, questionId: string, answers: Answers): Promise<void>;
  stopRun(runId: string): Promise<void>;
  subscribe(runId: string, listener: (update: RunUpdate) => void): () => void;
  /** Reads files from a live run's checkout, through its runner (architecture §5.2). */
  fetchFiles(
    runId: string,
    paths: readonly string[],
  ): Promise<readonly RunFile[]>;
  /** Fails every run a previous backend left live (architecture §5.3). */
  recoverAfterRestart(): Promise<void>;
  readonly gateway: RunnerGatewayOptions<RunRecord>;
}

export interface SupervisorOptions {
  readonly database: Kysely<Database>;
  readonly engine: ContainerEngine;
  readonly credentials: Pick<CredentialService, 'resolveForRun'>;
  readonly runs: RunStore;
  /** Makes each run's checkout before its container, and removes it when the run ends. */
  readonly checkouts: RunCheckouts;
  /** Where a runner reaches the gateway, from inside its container. */
  readonly gatewayUrl: string;
  /** Where a runner reaches the board tools (architecture §5.4), from inside its container. */
  readonly mcpUrl: string;
  readonly prepareDirectories: (
    runId: string,
    agentId: string,
  ) => Promise<void>;
  readonly connectTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  /** How long a runner has to answer `fetch_files`. */
  readonly fileRequestTimeoutMs?: number;
  /** How often an ending is tried before it is left to the next restart's recovery. */
  readonly endAttempts?: number;
  readonly endRetryMs?: number;
  readonly log?: (message: string) => void;
  /** Told of every run that ends, so queued work can take its place. */
  readonly onRunEnded?: (runId: string) => void;
}

export class RunNotFoundError extends Error {
  public constructor(runId: string) {
    super(`Run ${runId} was not found`);
    this.name = 'RunNotFoundError';
  }
}

export class RunEndedError extends Error {
  public constructor() {
    super('This conversation has ended.');
    this.name = 'RunEndedError';
  }
}

/** A file request the runner refused, answered wrongly, or did not answer in time. */
export class FileRequestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'FileRequestError';
  }
}

export class AgentUnavailableError extends Error {
  public constructor(
    public readonly code: 'disabled' | 'not_interactive' | 'already_running',
    message: string,
  ) {
    super(message);
    this.name = 'AgentUnavailableError';
  }
}

export class RunStartError extends Error {
  public constructor(
    public readonly runId: string,
    message: string,
  ) {
    super(message);
    this.name = 'RunStartError';
  }
}

interface TypeDefinition {
  readonly effort?: unknown;
  readonly image?: unknown;
  readonly resources?: { readonly cpus?: unknown; readonly memoryMb?: unknown };
}

interface LiveRun {
  connection: RunnerConnection<RunRecord> | null;
  connectTimer: ReturnType<typeof setTimeout> | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
  readonly pending: DownMessage[];
  /** File requests waiting for the runner's answer, by request id. */
  readonly fileRequests: Map<string, FileRequest>;
  start: StartMessage;
  /** Serialises the handling of one run's messages so events keep their order. */
  work: Promise<void>;
}

interface FileRequest {
  readonly paths: readonly string[];
  readonly timer: ReturnType<typeof setTimeout>;
  resolve(files: readonly RunFile[]): void;
  reject(error: Error): void;
}

/** Checks a runner's answer is exactly the files asked for, within the byte limit. */
function checkedFiles(
  request: FileRequest,
  message: FilesMessage,
): readonly RunFile[] {
  if ('error' in message) throw new FileRequestError(message.error);
  const asked = [...request.paths].sort();
  const answered = message.files.map((file) => file.path).sort();
  if (
    asked.length !== answered.length ||
    asked.some((path, index) => path !== answered[index])
  ) {
    throw new FileRequestError(
      'The runner answered with other files than asked for.',
    );
  }
  const bytes = message.files.reduce(
    (total, file) => total + Buffer.byteLength(file.content, 'base64'),
    0,
  );
  if (bytes > maxFetchBytes) {
    throw new FileRequestError(
      'The runner answered with more than the files may come to.',
    );
  }
  return message.files;
}

const stoppedReason = 'The navigator stopped the run.';

/**
 * Creates the per-agent directories the engine mounts, owned by the agent user when possible.
 * The run's checkout is made by the run checkouts, not here.
 */
export function directoryPreparer(
  dataDirectory: string,
): (runId: string, agentId: string) => Promise<void> {
  return async (_runId, agentId) => {
    const paths = [
      join(dataDirectory, 'agents', agentId, 'home'),
      join(dataDirectory, 'agents', agentId, 'cli-state'),
    ];
    for (const path of paths) {
      await mkdir(path, { recursive: true });
      if (process.getuid?.() === 0) {
        await chown(path, 1000, 1000);
      }
    }
  };
}

/** Producers and bugfixers both run as builders. */
export function runRoleOf(role: AgentRole): RunRecord['role'] {
  return role === 'producer' || role === 'bugfixer' ? 'builder' : role;
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === '23505'
  );
}

/**
 * Starts, feeds and ends agent runs (architecture §5.3): the container through the engine, the
 * conversation through the runner gateway, and the record through the run store.
 */
export function createSupervisor({
  database,
  engine,
  credentials,
  runs,
  checkouts,
  gatewayUrl,
  mcpUrl,
  prepareDirectories,
  connectTimeoutMs = 60_000,
  stopTimeoutMs = 30_000,
  fileRequestTimeoutMs = 30_000,
  endAttempts = 5,
  endRetryMs = 1_000,
  log = () => {},
  onRunEnded = () => {},
}: SupervisorOptions): Supervisor {
  const live = new Map<string, LiveRun>();
  const listeners = new Map<string, Set<(update: RunUpdate) => void>>();

  function publish(runId: string, update: RunUpdate): void {
    for (const listener of listeners.get(runId) ?? []) {
      try {
        listener(update);
      } catch (error) {
        log(`A listener of run ${runId} failed: ${failureText(error)}`);
      }
    }
  }

  async function removeContainer(runId: string, containerId: string | null) {
    if (containerId === null) return;
    try {
      await engine.stop(containerId);
    } catch (error) {
      log(
        `Run ${runId}: its container could not be stopped: ${failureText(error)}`,
      );
    }
    try {
      await engine.remove(containerId);
    } catch (error) {
      log(
        `Run ${runId}: its container could not be removed: ${failureText(error)}`,
      );
    }
  }

  async function removeCheckout(runId: string): Promise<void> {
    try {
      await checkouts.remove(runId);
    } catch (error) {
      log(
        `Run ${runId}: its checkout could not be removed: ${failureText(error)}`,
      );
    }
  }

  /** Records a run's ending, retrying so a passing database fault cannot leave it live. */
  async function recordEnding(runId: string, ending: EndRun): Promise<boolean> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await runs.end(runId, ending);
      } catch (error) {
        log(
          `Run ${runId}: its ending could not be recorded (attempt ${attempt}): ${failureText(error)}`,
        );
        if (attempt >= endAttempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, endRetryMs));
      }
    }
  }

  async function end(runId: string, ending: EndRun): Promise<void> {
    const entry = live.get(runId);
    live.delete(runId);
    if (entry !== undefined) {
      if (entry.connectTimer !== null) clearTimeout(entry.connectTimer);
      if (entry.stopTimer !== null) clearTimeout(entry.stopTimer);
      for (const request of entry.fileRequests.values()) {
        clearTimeout(request.timer);
        request.reject(new RunEndedError());
      }
      entry.fileRequests.clear();
    }
    entry?.connection?.close();
    try {
      if (await recordEnding(runId, ending)) {
        publish(runId, {
          failure: ending.failure ?? null,
          state: ending.state,
          type: 'state',
        });
        try {
          onRunEnded(runId);
        } catch (error) {
          log(
            `Run ${runId}: its ending could not be reported: ${failureText(error)}`,
          );
        }
      }
    } finally {
      const run = await runs.get(runId).catch(() => null);
      await removeContainer(runId, run?.containerId ?? null);
      // Only once no container can still write to it.
      await removeCheckout(runId);
    }
  }

  async function agentToStart(agentId: string) {
    if (!isUuid(agentId)) throw new AgentNotFoundError(agentId);
    const agent = await database
      .selectFrom('agents')
      .innerJoin('agent_types', 'agent_types.id', 'agents.agent_type_id')
      .leftJoin('agent_type_overrides', (join) =>
        join
          .onRef('agent_type_overrides.agent_type_id', '=', 'agent_types.id')
          .onRef('agent_type_overrides.project_id', '=', 'agents.project_id'),
      )
      .select([
        'agents.enabled',
        'agents.name',
        'agents.project_id',
        'agent_types.definition',
        'agent_types.instructions',
        'agent_types.interactive',
        'agent_types.model',
        'agent_types.name as type_name',
        'agent_types.role',
        'agent_type_overrides.fields',
      ])
      .where('agents.id', '=', agentId)
      .executeTakeFirst();
    if (agent === undefined) throw new AgentNotFoundError(agentId);
    return agent;
  }

  /**
   * Removes every container an earlier run of the agent left behind, so its home and CLI state
   * are never mounted by two containers (D17); throws if any may still be there.
   */
  async function clearEarlierContainers(agentId: string): Promise<void> {
    try {
      for (const id of await engine.containersOf(agentId)) {
        try {
          await engine.stop(id);
          await engine.remove(id);
        } catch (error) {
          if (!(error instanceof ContainerNotFoundError)) throw error;
        }
      }
    } catch (error) {
      throw new Error(
        `An earlier container of this agent is still there and could not be removed: ${failureText(error)}`,
        { cause: error },
      );
    }
  }

  async function launch(
    run: RunRecord,
    agentId: string,
    typeName: string,
    projectId: string,
    token: string,
    definition: TypeDefinition,
  ): Promise<void> {
    const resolved = await credentials.resolveForRun({
      agentType: typeName,
      projectId,
      runId: run.id,
    });
    if (!resolved.ok) {
      throw new Error(
        `Missing or unusable credentials: ${resolved.problems
          .map((problem) => problem.name)
          .join(', ')}.`,
      );
    }
    if (resolved.files.length > 0) {
      throw new Error('Credentials delivered as files are not supported yet.');
    }
    if (typeof definition.image !== 'string') {
      throw new Error('The agent type names no image.');
    }
    await checkouts.create({ projectId, runId: run.id });
    // Stopped while the checkout was being made: the ending removed nothing yet made.
    if (!live.has(run.id)) {
      await removeCheckout(run.id);
      return;
    }
    await prepareDirectories(run.id, agentId);
    if (!live.has(run.id)) return;
    await clearEarlierContainers(agentId);
    if (!live.has(run.id)) return;
    const container = await engine.create({
      agentId,
      environment: {
        ...resolved.environment,
        CEREBRA_GATEWAY_URL: gatewayUrl,
        CEREBRA_RUN_TOKEN: token,
      },
      image: definition.image,
      resources: {
        cpus: Number(definition.resources?.cpus ?? 1),
        memoryBytes:
          Number(definition.resources?.memoryMb ?? 2048) * 1024 * 1024,
      },
      runId: run.id,
    });
    await runs.setContainer(run.id, container.id);
    if (live.has(run.id)) await engine.start(container.id);
    // Stopped while the container was being made: the ending may not have seen it.
    if (!live.has(run.id)) await removeContainer(run.id, container.id);
  }

  /** Launches a run already recorded, ending it as failed to start if it cannot be. */
  async function begin(
    run: RunRecord,
    agentId: string,
    agent: Awaited<ReturnType<typeof agentToStart>>,
    token: string,
    opening: { readonly firstMessage: string; readonly interactive: boolean },
  ): Promise<void> {
    const definition = (
      typeof agent.definition === 'string'
        ? JSON.parse(agent.definition)
        : agent.definition
    ) as TypeDefinition;
    const entry: LiveRun = {
      connection: null,
      connectTimer: null,
      fileRequests: new Map(),
      pending: [],
      start: {
        backend: 'claude',
        effort:
          typeof definition.effort === 'string' ? definition.effort : 'high',
        firstMessage: opening.firstMessage,
        instructions: agent.instructions,
        interactive: opening.interactive,
        mcpServers: {
          cerebra: {
            headers: { Authorization: `Bearer ${token}` },
            type: 'http',
            url: mcpUrl,
          },
        },
        model: agent.fields?.model ?? agent.model,
        resumeSessionId: null,
        skills: [],
        type: 'start',
      },
      stopTimer: null,
      work: Promise.resolve(),
    };
    live.set(run.id, entry);
    try {
      await launch(
        run,
        agentId,
        agent.type_name,
        agent.project_id,
        token,
        definition,
      );
    } catch (error) {
      const failure = failureText(error);
      log(`Run ${run.id} could not start: ${failure}`);
      await end(run.id, {
        failure,
        reason: `The run failed to start: ${failure}`,
        startFailed: true,
        state: 'failed',
      });
      throw new RunStartError(run.id, `${agent.name} couldn’t start.`);
    }
    if (live.has(run.id) && entry.connection === null) {
      entry.connectTimer = setTimeout(() => {
        enqueue(run.id, entry, async () => {
          if (!live.has(run.id) || entry.connection !== null) return;
          const failure = 'The runner did not connect in time.';
          await end(run.id, {
            failure,
            reason: `The run failed: ${failure}`,
            state: 'failed',
          });
        });
      }, connectTimeoutMs);
    }
  }

  async function liveRun(runId: string): Promise<LiveRun> {
    const run = isUuid(runId) ? await runs.get(runId) : null;
    if (run === null) throw new RunNotFoundError(runId);
    const entry = live.get(runId);
    if (run.endedAt !== null || entry === undefined) throw new RunEndedError();
    return entry;
  }

  function deliver(entry: LiveRun, message: DownMessage): void {
    if (entry.connection === null) {
      entry.pending.push(message);
    } else {
      entry.connection.send(message);
    }
  }

  function answerFiles(runId: string, message: FilesMessage): void {
    const request = live.get(runId)?.fileRequests.get(message.requestId);
    if (request === undefined) {
      log(`Run ${runId}: an answer to no file request was ignored.`);
      return;
    }
    live.get(runId)?.fileRequests.delete(message.requestId);
    clearTimeout(request.timer);
    try {
      request.resolve(checkedFiles(request, message));
    } catch (error) {
      request.reject(error as Error);
    }
  }

  async function handle(runId: string, message: UpMessage): Promise<void> {
    if (message.type === 'files') {
      answerFiles(runId, message);
      return;
    }
    const event: AgentEvent = message.event;
    const record = await runs.append(runId, event);
    publish(runId, { type: 'event', ...record });
    if (event.kind === 'status') {
      if (await runs.setState(runId, event.status)) {
        publish(runId, { failure: null, state: event.status, type: 'state' });
      }
    } else if (event.kind === 'result') {
      await runs.addUsage(runId, {
        costUsd: event.usage.costUsd,
        ...(event.sessionId === undefined
          ? {}
          : { sessionId: event.sessionId }),
      });
      if (event.end === 'completed' || event.end === 'stopped') {
        await end(runId, {
          reason: event.end === 'stopped' ? stoppedReason : 'The run finished.',
          state: 'finished',
        });
      } else if (event.end === 'failed') {
        const failure = event.error ?? 'The agent failed.';
        await end(runId, {
          failure,
          reason: `The run failed: ${failure}`,
          state: 'failed',
        });
      }
    }
  }

  function enqueue(runId: string, entry: LiveRun, work: () => Promise<void>) {
    entry.work = entry.work.then(work).catch((error: unknown) => {
      log(`Run ${runId}: ${failureText(error)}`);
    });
  }

  const gateway: RunnerGatewayOptions<RunRecord> = {
    authenticate: (tokenHash) => runs.byTokenHash(tokenHash),
    accept(connection): RunnerListener {
      const runId = connection.run.id;
      const entry = live.get(runId);
      if (entry === undefined) {
        connection.close();
        return { closed: () => {}, message: () => {} };
      }
      if (entry.connectTimer !== null) clearTimeout(entry.connectTimer);
      entry.connectTimer = null;
      entry.connection = connection;
      connection.send(entry.start);
      for (const message of entry.pending.splice(0)) {
        connection.send(message);
      }
      return {
        closed(reason) {
          enqueue(runId, entry, async () => {
            if (!live.has(runId)) return;
            const failure = reason.problem ?? 'The runner disconnected.';
            await end(runId, {
              failure,
              reason: `The run failed: ${failure}`,
              state: 'failed',
            });
          });
        },
        message(message) {
          enqueue(runId, entry, () => handle(runId, message));
        },
      };
    },
  };

  return {
    gateway,

    async start(agentId) {
      const agent = await agentToStart(agentId);
      if (!agent.enabled) {
        throw new AgentUnavailableError(
          'disabled',
          `${agent.name} is turned off.`,
        );
      }
      if (!agent.interactive) {
        throw new AgentUnavailableError(
          'not_interactive',
          `${agent.name} starts from the board, not by hand.`,
        );
      }
      if ((await runs.liveFor(agentId)) !== null) {
        throw new AgentUnavailableError(
          'already_running',
          `${agent.name} is already running.`,
        );
      }
      const { token, hash } = createRunToken();
      let run: RunRecord;
      try {
        run = await runs.create({
          agentId,
          agentName: agent.name,
          projectId: agent.project_id,
          role: runRoleOf(agent.role),
          tokenHash: hash,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AgentUnavailableError(
            'already_running',
            `${agent.name} is already running.`,
          );
        }
        throw error;
      }
      await begin(run, agentId, agent, token, {
        firstMessage: '',
        interactive: true,
      });
      return { runId: run.id };
    },

    async launchDispatched({ agentId, firstMessage, runId, token }) {
      const agent = await agentToStart(agentId);
      const run = await runs.get(runId);
      if (run === null) throw new RunNotFoundError(runId);
      if (run.endedAt !== null) throw new RunEndedError();
      await begin(run, agentId, agent, token, {
        firstMessage,
        interactive: agent.interactive,
      });
    },

    async stop(agentId) {
      if (!isUuid(agentId)) throw new AgentNotFoundError(agentId);
      const run = await runs.liveFor(agentId);
      if (run !== null) await this.stopRun(run.id);
    },

    async stopRun(runId) {
      const run = isUuid(runId) ? await runs.get(runId) : null;
      if (run === null) throw new RunNotFoundError(runId);
      const entry = live.get(runId);
      if (run.endedAt !== null) return;
      if (entry === undefined || entry.connection === null) {
        await end(runId, { reason: stoppedReason, state: 'finished' });
        return;
      }
      entry.connection.send({ type: 'stop' });
      if (entry.stopTimer === null) {
        entry.stopTimer = setTimeout(() => {
          enqueue(runId, entry, async () => {
            if (live.has(runId)) {
              await end(runId, { reason: stoppedReason, state: 'finished' });
            }
          });
        }, stopTimeoutMs);
      }
    },

    read: (runId) => (isUuid(runId) ? runs.read(runId) : Promise.resolve(null)),

    async send(runId, text) {
      deliver(await liveRun(runId), { text, type: 'user_message' });
    },

    async answer(runId, questionId, answers) {
      deliver(await liveRun(runId), { answers, questionId, type: 'answer' });
    },

    async fetchFiles(runId, paths) {
      // A request the runner cannot parse would end its run.
      if (paths.length === 0) {
        throw new FileRequestError('Name at least one file to fetch.');
      }
      if (paths.length > maxFetchPaths) {
        throw new FileRequestError(
          `At most ${maxFetchPaths} files can be fetched at once.`,
        );
      }
      const entry = await liveRun(runId);
      const requestId = crypto.randomUUID();
      return new Promise<readonly RunFile[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          entry.fileRequests.delete(requestId);
          reject(
            new FileRequestError('The run did not send the files in time.'),
          );
        }, fileRequestTimeoutMs);
        entry.fileRequests.set(requestId, { paths, reject, resolve, timer });
        deliver(entry, { paths: [...paths], requestId, type: 'fetch_files' });
      });
    },

    subscribe(runId, listener) {
      const set = listeners.get(runId) ?? new Set();
      set.add(listener);
      listeners.set(runId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(runId);
      };
    },

    async recoverAfterRestart() {
      for (const run of await runs.live()) {
        const failure = 'Cerebra restarted while the run was live.';
        await runs.end(run.id, {
          failure,
          reason: `The run failed: ${failure}`,
          state: 'failed',
        });
        await removeContainer(run.id, run.containerId);
        await removeCheckout(run.id);
      }
      // Directories a crash left between a checkout and its run's record, or its removal.
      try {
        // A run's record is live before its checkout is made, so the database names every
        // run a start in progress could be making one for.
        const stillLive = (await runs.live()).map((run) => run.id);
        await checkouts.sweep(new Set([...live.keys(), ...stillLive]));
      } catch (error) {
        log(
          `The checkouts of ended runs could not be swept: ${failureText(error)}`,
        );
      }
    },
  };
}
