import { createBackend } from './backend.js';
import { parseBackupConfig } from './backups.js';
import { createDatabase } from './database.js';
import { loadMasterKey } from './master-key.js';
import { migrateToLatest } from './migrations/index.js';
import { createPodmanEngine } from './podman-engine.js';

const port = Number(process.env.CEREBRA_PORT ?? 4317);
// Drawings have a port, and so an origin, of their own (architecture §11).
const mockupPort = Number(process.env.CEREBRA_MOCKUP_PORT ?? 4318);
const mockupAddress =
  process.env.CEREBRA_MOCKUP_ADDRESS ?? `http://127.0.0.1:${mockupPort}`;
const databaseUrl = process.env.DATABASE_URL ?? '';
const database = createDatabase(databaseUrl);
const podmanSocket = process.env.CEREBRA_PODMAN_SOCKET;

try {
  // A malformed backup setting stops the start rather than quietly never backing up.
  const backupConfig = parseBackupConfig(process.env);
  const masterKey = await loadMasterKey();
  await migrateToLatest(database);
  const { mockupServer, server } = await createBackend({
    backupConfig,
    database,
    databaseUrl,
    dataDirectory: process.env.CEREBRA_DATA_DIR ?? '/data',
    // Agents run only when the engine's socket is mounted.
    engine:
      podmanSocket === undefined
        ? undefined
        : createPodmanEngine({
            dataVolume: process.env.CEREBRA_DATA_VOLUME ?? 'cerebra-data',
            egressNetwork:
              process.env.CEREBRA_EGRESS_NETWORK ?? 'cerebro-egress',
            internalNetwork:
              process.env.CEREBRA_INTERNAL_NETWORK ?? 'cerebro-internal',
            socketPath: podmanSocket,
          }),
    gatewayUrl: process.env.CEREBRA_GATEWAY_URL ?? 'ws://main:4317/runner',
    masterKey,
    mcpUrl: process.env.CEREBRA_MCP_URL ?? 'http://main:4317/mcp',
    mockupAddress,
    onClose: () => database.destroy(),
    uiDirectory: new URL('../../ui/dist', import.meta.url).pathname,
  });
  await mockupServer.listen({ host: '0.0.0.0', port: mockupPort });
  await server.listen({ host: '0.0.0.0', port });
} catch (error) {
  await database.destroy();
  throw error;
}
