import {
  createServer,
  startServer,
  type InstanceService,
} from '@cerebra/backend';
import { createServer as createNodeServer } from 'node:net';
import { afterEach, expect, test } from 'vitest';

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

test('serves a health response', async () => {
  const server = await createServer();
  servers.push(server);

  const response = await server.inject('/health');

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: 'ok' });
});

test('serves truthful local instance status', async () => {
  const server = await createServer({
    instance: {
      getStatus: () => ({
        address: 'http://localhost:4317',
        lastUpdatedAt: '2026-09-28T20:00:00.000Z',
        version: '0.0.0',
      }),
      requestUpdate: async () => ({ ok: true }),
    },
  });
  servers.push(server);

  const response = await server.inject('/api/instance');

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    address: 'http://localhost:4317',
    lastUpdatedAt: '2026-09-28T20:00:00.000Z',
    status: 'running',
    version: '0.0.0',
  });
});

test('reports an unavailable update explicitly', async () => {
  const instance: InstanceService = {
    getStatus: () => ({
      address: 'http://localhost:4317',
      lastUpdatedAt: '2026-09-28T20:00:00.000Z',
      version: '0.0.0',
    }),
    requestUpdate: async () => {
      throw new Error('The local update command is unavailable.');
    },
  };
  const server = await createServer({ instance });
  servers.push(server);

  const response = await server.inject({
    method: 'POST',
    url: '/api/instance/update',
  });

  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({
    error: 'The local update command is unavailable.',
  });
});

test('starts and stops cleanly', async () => {
  const server = await startServer({ host: '127.0.0.1', port: 0 });
  servers.push(server);
  const address = server.server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Expected the server to listen on a TCP port.');
  }

  expect(address.port).toBeGreaterThan(0);
});

test('echoes WebSocket messages', async () => {
  const server = await createServer();
  servers.push(server);
  await server.ready();
  const socket = await server.injectWS('/ws');

  const message = await new Promise<string>((resolve, reject) => {
    socket.once('message', (value) => {
      socket.close();
      resolve(value.toString());
    });
    socket.once('error', reject);
    socket.send('hello');
  });

  expect(message).toBe('hello');
});

test('rejects when it cannot start listening', async () => {
  const occupiedPort = await new Promise<number>((resolve, reject) => {
    const blocker = createNodeServer();
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', () => {
      const address = blocker.address();

      if (address === null || typeof address === 'string') {
        reject(new Error('Expected the blocker to listen on a TCP port.'));
        return;
      }

      resolve(address.port);
    });
    servers.push({
      close: () =>
        new Promise((closeResolve, closeReject) =>
          blocker.close((error) =>
            error ? closeReject(error) : closeResolve(),
          ),
        ),
    });
  });

  await expect(
    startServer({ host: '127.0.0.1', port: occupiedPort }),
  ).rejects.toThrow();
});
