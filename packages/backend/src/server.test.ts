import {
  createServer,
  GitHubAccessError,
  startServer,
  type InstanceService,
  type ProjectRegistration,
} from '@cerebra/backend';
import { createServer as createNodeServer } from 'node:net';
import { afterEach, expect, test } from 'vitest';

const servers: Array<{ close: () => Promise<void> }> = [];
const authenticatedAuth = {
  setup: async () => ({
    ok: false as const,
    reason: 'already-configured' as const,
  }),
  signIn: async () => ({
    ok: false as const,
    reason: 'rejected-password' as const,
  }),
  signOut: async () => undefined,
  status: async () => ({ state: 'authenticated' as const }),
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

test('serves a health response', async () => {
  const server = await createServer({ auth: authenticatedAuth });
  servers.push(server);

  const response = await server.inject('/health');

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: 'ok' });
});

test('serves truthful local instance status', async () => {
  const server = await createServer({
    auth: authenticatedAuth,
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
  const server = await createServer({ auth: authenticatedAuth, instance });
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

test('discovers a GitHub project without returning its credential', async () => {
  const projects: ProjectRegistration = {
    discover: async () => ({
      defaultBranch: 'main',
      name: 'website',
      owner: 'acme',
      prefix: 'WEBSITE',
      remote: 'https://github.com/acme/website.git',
    }),
    register: async () => {
      throw new Error('Not exercised');
    },
  };
  const server = await createServer({ projects });
  servers.push(server);

  const response = await server.inject({
    method: 'POST',
    payload: {
      credential: 'secret-token',
      remote: 'https://github.com/acme/website',
    },
    url: '/api/projects/discover',
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    defaultBranch: 'main',
    name: 'website',
    owner: 'acme',
    prefix: 'WEBSITE',
    remote: 'https://github.com/acme/website.git',
  });
  expect(response.body).not.toContain('secret-token');
});

test('reports inaccessible GitHub projects explicitly', async () => {
  const projects: ProjectRegistration = {
    discover: async () => {
      throw new GitHubAccessError();
    },
    register: async () => {
      throw new Error('Not exercised');
    },
  };
  const server = await createServer({ projects });
  servers.push(server);

  const response = await server.inject({
    method: 'POST',
    payload: {
      credential: 'secret-token',
      remote: 'https://github.com/acme/website',
    },
    url: '/api/projects/discover',
  });

  expect(response.statusCode).toBe(401);
  expect(response.json()).toEqual({
    error:
      'GitHub rejected the access token or it cannot read this repository.',
  });
});

test('starts and stops cleanly', async () => {
  const server = await startServer(
    { host: '127.0.0.1', port: 0 },
    { auth: authenticatedAuth },
  );
  servers.push(server);
  const address = server.server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Expected the server to listen on a TCP port.');
  }

  expect(address.port).toBeGreaterThan(0);
});

test('echoes WebSocket messages', async () => {
  const server = await createServer({ auth: authenticatedAuth });
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

test('creates a session and protects application routes', async () => {
  const server = await createServer({
    auth: {
      setup: async (password) =>
        password === 'a password'
          ? { ok: true, sessionToken: 'session-token' }
          : { ok: false, reason: 'invalid-password' },
      signIn: async () => ({ ok: false, reason: 'rejected-password' }),
      signOut: async () => undefined,
      status: async (sessionToken) =>
        sessionToken === 'session-token'
          ? { state: 'authenticated' }
          : { state: 'unauthenticated', reason: 'signed-out' },
    },
  });
  servers.push(server);

  const unauthorized = await server.inject('/api/instance');
  expect(unauthorized.statusCode).toBe(401);
  expect(unauthorized.json()).toEqual({
    error: 'Sign in to continue.',
    reason: 'signed-out',
  });

  const setup = await server.inject({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { password: 'a password' },
  });
  expect(setup.statusCode).toBe(201);
  expect(setup.headers['set-cookie']).toContain(
    'cerebra_session=session-token',
  );
  expect(setup.headers['set-cookie']).toContain('HttpOnly');
  expect(setup.headers['set-cookie']).toContain('SameSite=Strict');

  const authorized = await server.inject({
    url: '/api/instance',
    cookies: { cerebra_session: 'session-token' },
  });
  expect(authorized.statusCode).toBe(200);
});

test('clears an expired session and rejects unauthenticated event streams', async () => {
  const server = await createServer({
    auth: {
      setup: async () => ({ ok: false, reason: 'already-configured' }),
      signIn: async () => ({ ok: false, reason: 'rejected-password' }),
      signOut: async () => undefined,
      status: async () => ({ state: 'unauthenticated', reason: 'expired' }),
    },
  });
  servers.push(server);

  const status = await server.inject('/api/auth/status');
  expect(status.json()).toEqual({
    state: 'unauthenticated',
    reason: 'expired',
  });
  expect(status.headers['set-cookie']).toContain('Max-Age=0');

  await expect(server.injectWS('/ws')).rejects.toThrow();
  await expect(server.injectWS('/ws?stream=events')).rejects.toThrow();
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
    startServer(
      { host: '127.0.0.1', port: occupiedPort },
      { auth: authenticatedAuth },
    ),
  ).rejects.toThrow();
});
