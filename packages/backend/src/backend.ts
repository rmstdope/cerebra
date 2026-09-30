import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

import {
  agentTypesDirectory,
  readAgentTypeDefinitions,
} from './agent-types.js';
import { createAuthService } from './auth.js';
import { createBackups, createPgDump, type BackupConfig } from './backups.js';
import { createBoard } from './board.js';
import { createBoardTools, resolveCaller } from './board-tools.js';
import {
  createRunCheckouts,
  projectGitAccess,
  type RunCheckouts,
} from './checkouts.js';
import { createEnvelopeCipher } from './credential-cipher.js';
import { createCredentialService } from './credentials.js';
import { createFleet } from './fleet.js';
import { createAttention } from './attention.js';
import { createCostReader } from './costs.js';
import { projectGitHubForge, type ProjectForge } from './forge.js';
import { createMergeWatcher } from './merge-watcher.js';
import { createNavigatorQueue } from './navigator-queue.js';
import { createNotificationSettings } from './notification-settings.js';
import { createNotifier } from './notifier.js';
import {
  createProjectRegistrationService,
  listProjects,
} from './project-registration.js';
import { createRunnerGateway } from './runner-gateway.js';
import { createRunStore } from './runs.js';
import { createMcpEndpoint } from './mcp.js';
import { createServer } from './server.js';
import { createInvolvementSettings } from './involvement.js';
import { createPlanApprovals, type PlanApprovals } from './plan-approvals.js';
import { createDrawingQuestions, type DrawingQuestions } from './drawings.js';
import {
  createMockupServer,
  createMockupStore,
  type MockupStore,
} from './mockups.js';
import { createStartSettings } from './start-settings.js';
import {
  createSupervisor,
  directoryPreparer,
  type Supervisor,
} from './supervisor.js';
import { createDispatcher, type Dispatcher } from './dispatcher.js';

import type { Database } from './database.js';
import type { ContainerEngine } from './engine.js';

export interface BackendOptions {
  readonly database: Kysely<Database>;
  /** For the scheduled dumps, which run `pg_dump` against it. */
  readonly databaseUrl: string;
  readonly dataDirectory: string;
  /** Absent: no registration, credentials, merging or agents. */
  readonly masterKey: string | undefined;
  readonly backupConfig: BackupConfig | undefined;
  /** Absent: no agents run. */
  readonly engine: ContainerEngine | undefined;
  /** Where a runner reaches the gateway and the board tools, from inside its container. */
  readonly gatewayUrl: string;
  readonly mcpUrl: string;
  readonly uiDirectory: string;
  /** Where the drawing listener is reached from the browser; absent: drawings cannot be shown. */
  readonly mockupAddress?: string;
  /** The seams the end-to-end test replaces; production uses GitHub and the data directory. */
  readonly forge?: ProjectForge;
  readonly checkouts?: RunCheckouts;
  readonly prepareDirectories?: (
    runId: string,
    agentId: string,
  ) => Promise<void>;
  /** Backstop intervals, in milliseconds, for the dispatcher and the merge watcher. */
  readonly dispatchEveryMs?: number;
  readonly mergeEveryMs?: number;
  readonly log?: (message: string) => void;
  /** Runs last when the server closes, after every loop has stopped. */
  readonly onClose?: () => Promise<void>;
}

export interface Backend {
  readonly server: FastifyInstance;
  readonly plans: PlanApprovals | undefined;
  /** The designer's drawings question, for the tool that shows mockups (spec §6.2). */
  readonly drawings: DrawingQuestions | undefined;
  /** Where a designer's drawings are kept, for the tool that publishes them. */
  readonly mockups: MockupStore;
  /** The drawing listener, to be listened on its own port (architecture §11). */
  readonly mockupServer: FastifyInstance;
  readonly supervisor: Supervisor | undefined;
}

/** The application, composed: every service, loop and route, over one database. */
export async function createBackend(options: BackendOptions): Promise<Backend> {
  const { database, dataDirectory, backupConfig } = options;
  const projectTokenKey = options.masterKey;
  const log = options.log ?? ((message: string) => console.error(message));
  const fleet = createFleet(database);
  await fleet.seedAgentTypes(
    await readAgentTypeDefinitions(agentTypesDirectory),
  );
  await fleet.createMissingFleets();
  const credentials =
    projectTokenKey === undefined
      ? undefined
      : createCredentialService({
          cipher: createEnvelopeCipher(projectTokenKey),
          database,
        });
  // The dispatcher is created after the supervisor, which tells it whenever a run ends.
  const nudge = { current: () => {} };
  // Agents run only when there is an engine and credentials can be resolved.
  const supervisor =
    options.engine === undefined ||
    projectTokenKey === undefined ||
    credentials === undefined
      ? undefined
      : createSupervisor({
          checkouts:
            options.checkouts ??
            createRunCheckouts({
              dataDirectory,
              project: projectGitAccess(database, projectTokenKey),
            }),
          credentials,
          database,
          engine: options.engine,
          gatewayUrl: options.gatewayUrl,
          mcpUrl: options.mcpUrl,
          log,
          onRunEnded: () => nudge.current(),
          prepareDirectories:
            options.prepareDirectories ?? directoryPreparer(dataDirectory),
          runs: createRunStore(database),
        });
  await supervisor?.recoverAfterRestart();
  const dispatcher: Dispatcher | undefined =
    supervisor === undefined || credentials === undefined
      ? undefined
      : createDispatcher({
          credentials,
          database,
          launch: (run) => supervisor.launchDispatched(run),
          log,
        });
  nudge.current = () => dispatcher?.nudge();
  nudge.current();
  // A backstop for anything that changes without passing a request or a run's end.
  const dispatchTimer = setInterval(
    () => nudge.current(),
    options.dispatchEveryMs ?? 30_000,
  ).unref();
  const backups =
    backupConfig === undefined
      ? undefined
      : createBackups({
          config: backupConfig,
          database,
          dump: createPgDump({
            command: ['pg_dump'],
            databaseUrl: options.databaseUrl,
          }),
          log,
        });
  await backups?.recover();
  const backupTick = () => {
    backups
      ?.tick()
      .catch((error: unknown) =>
        log(`Could not check the backup schedule: ${String(error)}`),
      );
  };
  backupTick();
  const backupTimer = setInterval(backupTick, 60_000).unref();
  // The backend's merge and pull-request closing need the project's token.
  const mergeWatcher =
    projectTokenKey === undefined
      ? undefined
      : createMergeWatcher({
          database,
          forge: options.forge ?? projectGitHubForge(database, projectTokenKey),
          log,
        });
  mergeWatcher?.nudge();
  const mergeTimer = setInterval(
    () => mergeWatcher?.nudge(),
    options.mergeEveryMs ?? 30_000,
  ).unref();
  const board = createBoard(database);
  const plans =
    supervisor === undefined
      ? undefined
      : createPlanApprovals({
          database,
          note: (runId, event, state) => supervisor.note(runId, event, state),
        });
  const drawings =
    supervisor === undefined
      ? undefined
      : createDrawingQuestions({
          note: (runId, event, state) => supervisor.note(runId, event, state),
        });
  const mockups = createMockupStore(database);
  const mockupServer = createMockupServer({ mockups });
  const queue = createNavigatorQueue(database);
  const attention = createAttention(database, queue);
  const notificationSettings = createNotificationSettings(database);
  const notifications = createNotifier({
    attention,
    settings: notificationSettings,
  });
  // Pushes are found by comparing what needs the navigator every few seconds (architecture §11).
  const pollNotifications = () => {
    notifications.poll().catch(() => log('Could not check for notifications.'));
  };
  pollNotifications();
  const notificationTimer = setInterval(pollNotifications, 5_000).unref();
  const server = await createServer({
    attention,
    auth: createAuthService(database),
    backups,
    board,
    conversations: supervisor,
    costs: createCostReader(database),
    credentials,
    fleet,
    listProjects: () => listProjects(database),
    projects:
      projectTokenKey === undefined
        ? undefined
        : createProjectRegistrationService({
            dataDirectory,
            database,
            masterKey: projectTokenKey,
          }),
    notificationSettings,
    notifications,
    queue,
    runnerGateway:
      supervisor === undefined
        ? undefined
        : createRunnerGateway(supervisor.gateway),
    mcp:
      supervisor === undefined
        ? undefined
        : createMcpEndpoint({
            authenticate: (tokenHash) => resolveCaller(database, tokenHash),
            tools: createBoardTools({
              board,
              database,
              // The item left its run: the run finishes with its turn, and the item's new queue may start work.
              onReleased: (runId) => {
                supervisor.finishAfterTurn(runId);
                nudge.current();
              },
              ...(plans === undefined ? {} : { plans }),
            }),
          }),
    runs: supervisor,
    dispatcher,
    onMutation: () => {
      nudge.current();
      mergeWatcher?.nudge();
    },
    startSettings: createStartSettings(database),
    involvement: createInvolvementSettings(database),
    ...(plans === undefined ? {} : { plans }),
    ...(drawings === undefined ? {} : { drawings }),
    ...(options.mockupAddress === undefined
      ? {}
      : { mockups: { address: options.mockupAddress, store: mockups } }),
    uiDirectory: options.uiDirectory,
  });
  server.addHook('onClose', async () => {
    clearInterval(dispatchTimer);
    clearInterval(notificationTimer);
    notifications.stop();
    clearInterval(backupTimer);
    clearInterval(mergeTimer);
    await dispatcher?.idle();
    await backups?.idle();
    await mockupServer.close();
    await options.onClose?.();
  });
  return { server, plans, drawings, mockups, mockupServer, supervisor };
}
