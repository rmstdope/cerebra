export const packageName = '@cerebra/backend';

export { createDatabase, type Database } from './database.js';
export { migrateToLatest } from './migrations/index.js';
export { createServer, startServer } from './server.js';
