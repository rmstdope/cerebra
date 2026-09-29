import {
  agentTypesDirectory,
  readAgentTypeDefinitions,
} from './agent-types.js';
import { createAuthService } from './auth.js';
import { createBoard } from './board.js';
import { createEnvelopeCipher } from './credential-cipher.js';
import { createCredentialService } from './credentials.js';
import { createDatabase } from './database.js';
import { createFleet } from './fleet.js';
import { migrateToLatest } from './migrations/index.js';
import { createNavigatorQueue } from './navigator-queue.js';
import { createProjectRegistrationService } from './project-registration.js';
import { createPodmanEngine } from './podman-engine.js';
import { createRunnerGateway } from './runner-gateway.js';
import { createRunStore } from './runs.js';
import { startServer } from './server.js';
import { createSupervisor, directoryPreparer } from './supervisor.js';

const port = Number(process.env.CEREBRA_PORT ?? 4317);
const database = createDatabase(process.env.DATABASE_URL ?? '');
const projectTokenKey = process.env.CEREBRA_PROJECT_TOKEN_KEY;
const dataDirectory = process.env.CEREBRA_DATA_DIR ?? '/data';
const podmanSocket = process.env.CEREBRA_PODMAN_SOCKET;

try {
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
  // Agents run only when the engine's socket is mounted and credentials can be resolved.
  const supervisor =
    podmanSocket === undefined || credentials === undefined
      ? undefined
      : createSupervisor({
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
          log: (message) => console.error(message),
          prepareDirectories: directoryPreparer(dataDirectory),
          runs: createRunStore(database),
        });
  await supervisor?.recoverAfterRestart();
  const server = await startServer(
    { host: '0.0.0.0', port },
    {
      auth: createAuthService(database),
      board: createBoard(database),
      conversations: supervisor,
      credentials,
      fleet,
      projects:
        projectTokenKey === undefined
          ? undefined
          : createProjectRegistrationService({
              dataDirectory,
              database,
              masterKey: projectTokenKey,
            }),
      queue: createNavigatorQueue(database),
      runnerGateway:
        supervisor === undefined
          ? undefined
          : createRunnerGateway(supervisor.gateway),
      runs: supervisor,
      uiDirectory: new URL('../../ui/dist', import.meta.url).pathname,
    },
  );
  server.addHook('onClose', async () => database.destroy());
} catch (error) {
  await database.destroy();
  throw error;
}
