export const packageName = '@cerebra/backend';

export { createDatabase, type Database } from './database.js';
export {
  createInstanceService,
  type InstanceService,
  type InstanceStatus,
} from './instance.js';
export { migrateToLatest } from './migrations/index.js';
export { createServer, startServer } from './server.js';
