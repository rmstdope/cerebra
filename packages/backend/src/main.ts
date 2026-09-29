import {
  agentTypesDirectory,
  readAgentTypeDefinitions,
} from './agent-types.js';
import { createAuthService } from './auth.js';
import { createBackups, createPgDump, parseBackupConfig } from './backups.js';
import { createBoard } from './board.js';
import { createBoardTools, resolveCaller } from './board-tools.js';
import { createRunCheckouts, projectGitAccess } from './checkouts.js';
import { createEnvelopeCipher } from './credential-cipher.js';
import { createCredentialService } from './credentials.js';
import { createDatabase } from './database.js';
import { createFleet } from './fleet.js';
import { loadMasterKey } from './master-key.js';
import { migrateToLatest } from './migrations/index.js';
import { createAttention } from './attention.js';
import { createCostReader } from './costs.js';
import { projectGitHubForge } from './forge.js';
import { createMergeWatcher } from './merge-watcher.js';
import { createNavigatorQueue } from './navigator-queue.js';
import { createNotificationSettings } from './notification-settings.js';
import { createNotifier } from './notifier.js';
import {
  createProjectRegistrationService,
  listProjects,
} from './project-registration.js';
import { createPodmanEngine } from './podman-engine.js';
import { createRunnerGateway } from './runner-gateway.js';
import { createRunStore } from './runs.js';
import { createMcpEndpoint } from './mcp.js';
import { createServer } from './server.js';
import { createInvolvementSettings } from './involvement.js';
import { createStartSettings } from './start-settings.js';
import { createSupervisor, directoryPreparer } from './supervisor.js';
import { createDispatcher, type Dispatcher } from './dispatcher.js';

const port = Number(process.env.CEREBRA_PORT ?? 4317);
const database = createDatabase(process.env.DATABASE_URL ?? '');
const dataDirectory = process.env.CEREBRA_DATA_DIR ?? '/data';
const podmanSocket = process.env.CEREBRA_PODMAN_SOCKET;

try {
  // A malformed backup setting stops the start rather than quietly never backing up.
  const backupConfig = parseBackupConfig(process.env);
  const projectTokenKey = await loadMasterKey();
  await migrateToLatest(database);
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
  // Agents run only when the engine's socket is mounted and credentials can be resolved.
  const supervisor =
    podmanSocket === undefined ||
    projectTokenKey === undefined ||
    credentials === undefined
      ? undefined
      : createSupervisor({
          checkouts: createRunCheckouts({
            dataDirectory,
            project: projectGitAccess(database, projectTokenKey),
          }),
          credentials,
          database,
          engine: createPodmanEngine({
            dataVolume: process.env.CEREBRA_DATA_VOLUME ?? 'cerebra-data',
            egressNetwork:
              process.env.CEREBRA_EGRESS_NETWORK ?? 'cerebro-egress',
            internalNetwork:
              process.env.CEREBRA_INTERNAL_NETWORK ?? 'cerebro-internal',
            socketPath: podmanSocket,
          }),
          gatewayUrl:
            process.env.CEREBRA_GATEWAY_URL ?? 'ws://main:4317/runner',
          mcpUrl: process.env.CEREBRA_MCP_URL ?? 'http://main:4317/mcp',
          log: (message) => console.error(message),
          onRunEnded: () => nudge.current(),
          prepareDirectories: directoryPreparer(dataDirectory),
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
          log: (message) => console.error(message),
        });
  nudge.current = () => dispatcher?.nudge();
  nudge.current();
  // A backstop for anything that changes without passing a request or a run's end.
  const dispatchTimer = setInterval(() => nudge.current(), 30_000).unref();
  const backups =
    backupConfig === undefined
      ? undefined
      : createBackups({
          config: backupConfig,
          database,
          dump: createPgDump({
            command: ['pg_dump'],
            databaseUrl: process.env.DATABASE_URL ?? '',
          }),
          log: (message) => console.error(message),
        });
  await backups?.recover();
  const backupTick = () => {
    backups
      ?.tick()
      .catch((error: unknown) =>
        console.error(`Could not check the backup schedule: ${String(error)}`),
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
          forge: projectGitHubForge(database, projectTokenKey),
          log: (message) => console.error(message),
        });
  mergeWatcher?.nudge();
  const mergeTimer = setInterval(() => mergeWatcher?.nudge(), 30_000).unref();
  const board = createBoard(database);
  const queue = createNavigatorQueue(database);
  const attention = createAttention(database, queue);
  const notificationSettings = createNotificationSettings(database);
  const notifications = createNotifier({
    attention,
    settings: notificationSettings,
  });
  // Pushes are found by comparing what needs the navigator every few seconds (architecture §11).
  const pollNotifications = () => {
    notifications
      .poll()
      .catch(() => console.error('Could not check for notifications.'));
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
    uiDirectory: new URL('../../ui/dist', import.meta.url).pathname,
  });
  server.addHook('onClose', async () => {
    clearInterval(dispatchTimer);
    clearInterval(notificationTimer);
    notifications.stop();
    clearInterval(backupTimer);
    clearInterval(mergeTimer);
    await dispatcher?.idle();
    await backups?.idle();
    await database.destroy();
  });
  await server.listen({ host: '0.0.0.0', port });
} catch (error) {
  await database.destroy();
  throw error;
}
