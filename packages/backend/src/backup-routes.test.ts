import { createServer, type Backups } from '@cerebra/backend';
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

const status = {
  backups: [
    {
      at: new Date('2026-09-28T02:00:41.000Z'),
      cause: null,
      id: '3',
      sizeBytes: 48_200_000,
      status: 'completed' as const,
    },
  ],
  kept: 1,
  running: null,
  schedule: {
    keep: 7,
    location: '~/cerebra-backups',
    nextAt: new Date('2026-09-29T02:00:00.000Z'),
  },
};

function fakeBackups(overrides: Partial<Backups> = {}): Backups {
  return {
    idle: async () => undefined,
    recover: async () => undefined,
    start: async () => ({ started: true }),
    status: async () => status,
    tick: async () => undefined,
    ...overrides,
  };
}

test('reads the backups settings', async () => {
  const server = await createServer({
    auth: authenticatedAuth,
    backups: fakeBackups(),
  });
  servers.push(server);

  const response = await server.inject('/api/settings/backups');

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    backups: [
      {
        at: '2026-09-28T02:00:41.000Z',
        cause: null,
        id: '3',
        sizeBytes: 48_200_000,
        status: 'completed',
      },
    ],
    kept: 1,
    running: null,
    schedule: {
      keep: 7,
      location: '~/cerebra-backups',
      nextAt: '2026-09-29T02:00:00.000Z',
    },
  });
});

test('starts a manual backup and answers with the running status', async () => {
  const triggers: string[] = [];
  const server = await createServer({
    auth: authenticatedAuth,
    backups: fakeBackups({
      start: async (trigger) => {
        triggers.push(trigger);
        return { started: true };
      },
      status: async () => ({
        ...status,
        running: { startedAt: new Date('2026-09-28T09:00:00.000Z') },
      }),
    }),
  });
  servers.push(server);

  const response = await server.inject({
    method: 'POST',
    url: '/api/settings/backups',
  });

  expect(response.statusCode).toBe(202);
  expect(response.json().running).toEqual({
    startedAt: '2026-09-28T09:00:00.000Z',
  });
  expect(triggers).toEqual(['manual']);
});

test('refuses a second backup while one runs', async () => {
  const server = await createServer({
    auth: authenticatedAuth,
    backups: fakeBackups({
      start: async () => ({ reason: 'already_running', started: false }),
    }),
  });
  servers.push(server);

  const response = await server.inject({
    method: 'POST',
    url: '/api/settings/backups',
  });

  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({
    code: 'already_running',
    error: 'A backup is already running.',
  });
});

test('answers 503 when backups are not configured', async () => {
  const server = await createServer({ auth: authenticatedAuth });
  servers.push(server);

  const read = await server.inject('/api/settings/backups');
  const start = await server.inject({
    method: 'POST',
    url: '/api/settings/backups',
  });

  expect(read.statusCode).toBe(503);
  expect(read.json()).toEqual({ error: 'Backups are unavailable.' });
  expect(start.statusCode).toBe(503);
});

test('requires a session', async () => {
  const server = await createServer({
    auth: {
      ...authenticatedAuth,
      status: async () => ({
        reason: 'signed-out' as const,
        state: 'unauthenticated' as const,
      }),
    },
    backups: fakeBackups(),
  });
  servers.push(server);

  const response = await server.inject('/api/settings/backups');

  expect(response.statusCode).toBe(401);
});
