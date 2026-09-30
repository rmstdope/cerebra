import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, expect, test, vi } from 'vitest';
import type { ServerOptions } from './server.js';

const startup = vi.hoisted(() => ({
  destroy: vi.fn(async () => undefined),
  readSecret: vi.fn(async () => Buffer.alloc(32, 7).toString('base64')),
  server: undefined as FastifyInstance | undefined,
  options: undefined as ServerOptions | undefined,
}));

vi.mock('./master-key.js', async (importOriginal) => {
  const { loadMasterKey } =
    await importOriginal<typeof import('./master-key.js')>();
  return {
    loadMasterKey: () => loadMasterKey(process.env, startup.readSecret),
  };
});

vi.mock('./database.js', () => ({
  createDatabase: () => ({ destroy: startup.destroy }),
}));

vi.mock('./migrations/index.js', () => ({
  migrateToLatest: vi.fn(async () => []),
}));

vi.mock('./fleet.js', () => ({
  createFleet: () => ({
    seedAgentTypes: vi.fn(async () => undefined),
    createMissingFleets: vi.fn(async () => undefined),
  }),
}));

vi.mock('./agent-types.js', () => ({
  agentTypesDirectory: '/unused',
  readAgentTypeDefinitions: vi.fn(async () => []),
}));

vi.mock('./server.js', () => ({
  createServer: async (options: ServerOptions) => {
    startup.options = options;
    startup.server = Fastify();
    return startup.server;
  },
  startServer: async () => {
    startup.server = Fastify();
    await startup.server.listen({ host: '127.0.0.1', port: 0 });
    return startup.server;
  },
}));

afterEach(async () => {
  await startup.server?.close();
  startup.server = undefined;
  startup.options = undefined;
  vi.clearAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
});

test('starts the application and releases its database when closed', async () => {
  vi.stubEnv('CEREBRA_PORT', '0');
  vi.stubEnv('CEREBRA_MOCKUP_PORT', '0');
  vi.stubEnv('CEREBRA_PROJECT_TOKEN_KEY', undefined);
  vi.stubEnv('CEREBRA_PROJECT_TOKEN_KEY_FILE', undefined);

  await import('./main.js');

  expect(startup.server?.server.listening).toBe(true);
  expect(startup.destroy).not.toHaveBeenCalled();
  await startup.server?.close();
  expect(startup.destroy).toHaveBeenCalledTimes(1);
});

test('enables registration and credentials using the mounted master key', async () => {
  vi.stubEnv('CEREBRA_PORT', '0');
  vi.stubEnv('CEREBRA_MOCKUP_PORT', '0');
  vi.stubEnv('CEREBRA_PROJECT_TOKEN_KEY', undefined);
  vi.stubEnv('CEREBRA_PROJECT_TOKEN_KEY_FILE', '/run/secrets/key');

  await import('./main.js');

  expect(startup.readSecret).toHaveBeenCalledWith('/run/secrets/key', 'utf8');
  expect(startup.options?.projects).toBeDefined();
  expect(startup.options?.credentials).toBeDefined();
  expect(startup.server?.server.listening).toBe(true);
});

test('serves drawings from a listener of its own, at the address the browser reaches', async () => {
  vi.stubEnv('CEREBRA_PORT', '0');
  vi.stubEnv('CEREBRA_MOCKUP_PORT', '0');
  vi.stubEnv('CEREBRA_MOCKUP_ADDRESS', 'http://localhost:4999');
  vi.stubEnv('CEREBRA_PROJECT_TOKEN_KEY', undefined);
  vi.stubEnv('CEREBRA_PROJECT_TOKEN_KEY_FILE', undefined);

  await import('./main.js');

  expect(startup.options?.mockups?.address).toBe('http://localhost:4999');
  expect(startup.server?.server.listening).toBe(true);
});

test('closes the database and never listens if the configured secret is unreadable', async () => {
  vi.stubEnv('CEREBRA_PROJECT_TOKEN_KEY', undefined);
  vi.stubEnv('CEREBRA_PROJECT_TOKEN_KEY_FILE', '/run/secrets/key');
  startup.readSecret.mockRejectedValueOnce(
    new Error('private storage details'),
  );

  await expect(import('./main.js')).rejects.toThrow('Cannot read');

  expect(startup.server).toBeUndefined();
  expect(startup.destroy).toHaveBeenCalledTimes(1);
});
