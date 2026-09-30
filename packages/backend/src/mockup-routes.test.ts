import { afterEach, expect, test } from 'vitest';

import {
  createMockupServer,
  mockupContentSecurityPolicy,
  type Mockup,
} from './mockups.js';
import { createServer } from './server.js';

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const known = '44444444-4444-4444-8444-444444444444';
const page = '<!doctype html><p>A</p>';

const store = {
  find: async (id: string): Promise<Mockup | null> =>
    id === known
      ? { content: Buffer.from(page), contentType: 'text/html' }
      : null,
};

function authAs(state: 'authenticated' | 'unauthenticated') {
  return {
    setup: async () => ({
      ok: false as const,
      reason: 'already-configured' as const,
    }),
    signIn: async () => ({
      ok: false as const,
      reason: 'rejected-password' as const,
    }),
    signOut: async () => undefined,
    status: async () =>
      state === 'authenticated'
        ? { state: 'authenticated' as const }
        : { reason: 'signed-out' as const, state: 'unauthenticated' as const },
  };
}

function listener() {
  const server = createMockupServer({ mockups: store });
  servers.push(server);
  return server;
}

async function app(
  state: 'authenticated' | 'unauthenticated' = 'authenticated',
  listening = true,
) {
  const server = await createServer({
    auth: authAs(state),
    ...(listening
      ? { mockups: { address: 'http://localhost:4318', store } }
      : {}),
  });
  servers.push(server);
  return server;
}

test('the drawing listener serves a drawing sandboxed, with nothing cached or referred', async () => {
  const response = await listener().inject(`/mockups/${known}`);

  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
  expect(response.headers['content-security-policy']).toBe(
    mockupContentSecurityPolicy,
  );
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['referrer-policy']).toBe('no-referrer');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body.startsWith(page)).toBe(true);
});

test('the drawing listener serves nothing but known drawings, all under the sandbox', async () => {
  const server = listener();

  for (const url of [
    '/mockups/55555555-5555-4555-8555-555555555555',
    '/mockups/not-an-id',
    '/',
    '/api/instance',
    '/health',
  ]) {
    const response = await server.inject(url);
    expect(response.statusCode, url).toBe(404);
    expect(response.headers['content-security-policy'], url).toBe(
      mockupContentSecurityPolicy,
    );
  }
});

test('the drawing listener reads no session: a drawing is the same with or without one', async () => {
  const server = listener();

  const without = await server.inject(`/mockups/${known}`);
  const withCookie = await server.inject({
    headers: { cookie: 'cerebra_session=secret' },
    url: `/mockups/${known}`,
  });

  expect(withCookie.body).toBe(without.body);
  expect(withCookie.headers['set-cookie']).toBeUndefined();
});

test('the application tells a signed-in page where a drawing is served', async () => {
  const response = await (await app()).inject(`/api/mockups/${known}`);

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    url: `http://localhost:4318/mockups/${known}`,
  });
});

test('where a drawing is served is only for a signed-in page', async () => {
  const response = await (
    await app('unauthenticated')
  ).inject(`/api/mockups/${known}`);

  expect(response.statusCode).toBe(401);
});

test('an unknown drawing is an explicit failure, never an address', async () => {
  const server = await app();

  for (const id of ['55555555-5555-4555-8555-555555555555', 'not-an-id']) {
    const response = await server.inject(`/api/mockups/${id}`);
    expect(response.statusCode, id).toBe(404);
    expect(response.json(), id).toEqual({
      error: 'This drawing couldn’t be shown.',
    });
  }
});

test('without a drawing listener the application says drawings cannot be shown', async () => {
  const response = await (
    await app('authenticated', false)
  ).inject(`/api/mockups/${known}`);

  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({
    error: 'This drawing couldn’t be shown.',
  });
});

test("the application's pages may frame only the drawing listener's origin", async () => {
  const framed = String(
    (await (await app()).inject('/health')).headers['content-security-policy'],
  );
  const unframed = String(
    (await (await app('authenticated', false)).inject('/health')).headers[
      'content-security-policy'
    ],
  );

  expect(framed.split('; ')).toContain('frame-src http://localhost:4318');
  expect(unframed.split('; ')).toContain("frame-src 'none'");
});
