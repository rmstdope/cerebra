import { createAuthService } from './auth.js';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrations/index.js';
import { startServer } from './server.js';

const port = Number(process.env.CEREBRA_PORT ?? 4317);
const database = createDatabase(process.env.DATABASE_URL ?? '');

try {
  await migrateToLatest(database);
  const server = await startServer(
    { host: '0.0.0.0', port },
    {
      auth: createAuthService(database),
      uiDirectory: new URL('../../ui/dist', import.meta.url).pathname,
    },
  );
  server.addHook('onClose', async () => database.destroy());
} catch (error) {
  await database.destroy();
  throw error;
}
