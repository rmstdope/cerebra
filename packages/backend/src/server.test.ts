import { createServer, startServer } from '@cerebra/backend';
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
