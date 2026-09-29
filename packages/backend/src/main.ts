import {
  agentTypesDirectory,
  readAgentTypeDefinitions,
} from './agent-types.js';
import { createAuthService } from './auth.js';
import { createBoard } from './board.js';
import { createDatabase } from './database.js';
import { createFleet } from './fleet.js';
import { migrateToLatest } from './migrations/index.js';
import { createNavigatorQueue } from './navigator-queue.js';
import { createProjectRegistrationService } from './project-registration.js';
import { startServer } from './server.js';

const port = Number(process.env.CEREBRA_PORT ?? 4317);
const database = createDatabase(process.env.DATABASE_URL ?? '');
const projectTokenKey = process.env.CEREBRA_PROJECT_TOKEN_KEY;

try {
  await migrateToLatest(database);
  const fleet = createFleet(database);
  await fleet.seedAgentTypes(
    await readAgentTypeDefinitions(agentTypesDirectory),
  );
  await fleet.createMissingFleets();
  const server = await startServer(
    { host: '0.0.0.0', port },
    {
      auth: createAuthService(database),
      board: createBoard(database),
      fleet,
      projects:
        projectTokenKey === undefined
          ? undefined
          : createProjectRegistrationService({
              dataDirectory: process.env.CEREBRA_DATA_DIR ?? '/data',
              database,
              masterKey: projectTokenKey,
            }),
      queue: createNavigatorQueue(database),
      uiDirectory: new URL('../../ui/dist', import.meta.url).pathname,
    },
  );
  server.addHook('onClose', async () => database.destroy());
} catch (error) {
  await database.destroy();
  throw error;
}
