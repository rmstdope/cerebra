import {
  createRunToken,
  createRunnerGateway,
  createServer,
  hashRunToken,
  type RunnerConnection,
} from '@cerebra/backend';
import {
  runnerProtocol,
  type DownMessage,
  type UpMessage,
} from '@cerebra/shared';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';

interface Run {
  readonly id: string;
  readonly project: string;
}

const servers: FastifyInstance[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    // A refused upgrade leaves the client connecting; ending it then reports an error.
    socket.on('error', () => {});
    socket.terminate();
  }
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const signedOut = {
  setup: async () => ({
    ok: false as const,
    reason: 'already-configured' as const,
  }),
  signIn: async () => ({
    ok: false as const,
    reason: 'rejected-password' as const,
  }),
  signOut: async () => undefined,
  status: async () => ({
    state: 'unauthenticated' as const,
    reason: 'missing' as const,
  }),
};

interface Harness {
  readonly url: string;
  readonly token: string;
  readonly connections: RunnerConnection<Run>[];
  readonly messages: UpMessage[];
  readonly closes: { runId: string; code: number; problem?: string }[];
  readonly hashes: string[];
}

async function harness(): Promise<Harness> {
  const { token, hash } = createRunToken();
  const runs = new Map<string, Run>([
    [hash, { id: 'run-1', project: 'cerebra' }],
  ]);
  const created: Omit<Harness, 'url'> = {
    token,
    connections: [],
    messages: [],
    closes: [],
    hashes: [],
  };
  const server = await createServer({
    auth: signedOut,
    runnerGateway: createRunnerGateway<Run>({
      authenticate: async (tokenHash) => {
        created.hashes.push(tokenHash);
        return runs.get(tokenHash) ?? null;
      },
      accept: (connection) => {
        created.connections.push(connection);
        return {
          message: (message) => created.messages.push(message),
          closed: (reason) =>
            created.closes.push({ runId: connection.run.id, ...reason }),
        };
      },
    }),
  });
  servers.push(server);
  await server.listen({ host: '127.0.0.1', port: 0 });
  const { port } = server.server.address() as AddressInfo;
  return { ...created, url: `ws://127.0.0.1:${port}/runner` };
}

function connect(
  url: string,
  options: { token?: string; protocol?: string | null } = {},
): WebSocket {
  const socket = new WebSocket(
    url,
    options.protocol === null ? [] : [options.protocol ?? runnerProtocol],
    options.token === undefined
      ? {}
      : { headers: { Authorization: `Bearer ${options.token}` } },
  );
  sockets.push(socket);
  return socket;
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

function refused(socket: WebSocket): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    socket.once('open', () =>
      reject(new Error('The gateway accepted the runner')),
    );
    socket.once('unexpected-response', (_request, response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => (body += String(chunk)));
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, body }),
      );
    });
  });
}

function closed(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) =>
    socket.once('close', (code, reason) =>
      resolve({ code, reason: String(reason) }),
    ),
  );
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !check(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(check()).toBe(true);
}

const event: UpMessage = {
  type: 'event',
  seq: 1,
  event: { kind: 'status', status: 'active' },
};

describe('run tokens', () => {
  test('are random, and only their hash is kept', () => {
    const first = createRunToken();
    const second = createRunToken();

    expect(first.token).not.toBe(second.token);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.hash).toBe(hashRunToken(first.token));
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the runner gateway', () => {
  test('accepts a runner by its run token, outside the navigator session', async () => {
    const gate = await harness();

    const socket = connect(gate.url, { token: gate.token });
    await opened(socket);

    expect(socket.protocol).toBe(runnerProtocol);
    expect(gate.hashes).toEqual([hashRunToken(gate.token)]);
    expect(gate.connections.map((connection) => connection.run)).toEqual([
      { id: 'run-1', project: 'cerebra' },
    ]);
  });

  test('routes what the runner sends to the run, and what the run sends to the runner', async () => {
    const gate = await harness();
    const socket = connect(gate.url, { token: gate.token });
    const received: DownMessage[] = [];
    socket.on('message', (data) =>
      received.push(JSON.parse(String(data)) as DownMessage),
    );
    await opened(socket);

    socket.send(JSON.stringify(event));
    gate.connections[0]?.send({ type: 'user_message', text: 'Carry on' });

    await until(() => gate.messages.length === 1 && received.length === 1);
    expect(gate.messages).toEqual([event]);
    expect(received).toEqual([{ type: 'user_message', text: 'Carry on' }]);
  });

  test('refuses a runner without a known run token', async () => {
    const gate = await harness();

    const missing = await refused(connect(gate.url));
    const unknown = await refused(connect(gate.url, { token: 'forged' }));

    expect(missing).toEqual({
      status: 401,
      body: JSON.stringify({ error: 'Unknown run token.' }),
    });
    expect(unknown.status).toBe(401);
    expect(gate.connections).toEqual([]);
  });

  test('refuses a runner that does not speak the runner protocol', async () => {
    const gate = await harness();

    const other = await refused(
      connect(gate.url, { token: gate.token, protocol: 'cerebra-runner.v0' }),
    );
    const none = await refused(
      connect(gate.url, { token: gate.token, protocol: null }),
    );

    expect(other).toEqual({
      status: 400,
      body: JSON.stringify({ error: `Speak ${runnerProtocol}.` }),
    });
    expect(none.status).toBe(400);
  });

  test('refuses a second runner for a run that is connected, and takes one again once it leaves', async () => {
    const gate = await harness();
    const first = connect(gate.url, { token: gate.token });
    await opened(first);

    const second = await refused(connect(gate.url, { token: gate.token }));
    expect(second).toEqual({
      status: 409,
      body: JSON.stringify({
        error: 'This run already has a runner connected.',
      }),
    });

    first.close();
    await until(() => gate.closes.length === 1);
    await opened(connect(gate.url, { token: gate.token }));
    expect(gate.connections).toHaveLength(2);
  });

  test('closes a runner that sends something unreadable, and tells the run why', async () => {
    const gate = await harness();
    const socket = connect(gate.url, { token: gate.token });
    await opened(socket);
    const closing = closed(socket);

    socket.send(JSON.stringify({ type: 'event', seq: 0, event: event.event }));

    await expect(closing).resolves.toEqual({
      code: 1008,
      reason: 'event.seq must be a positive integer',
    });
    await until(() => gate.closes.length === 1);
    expect(gate.closes).toEqual([
      {
        runId: 'run-1',
        code: 1008,
        problem: 'event.seq must be a positive integer',
      },
    ]);
  });

  test('tells the run when its runner goes, and lets the run close it', async () => {
    const gate = await harness();
    const socket = connect(gate.url, { token: gate.token });
    await opened(socket);
    const closing = closed(socket);

    gate.connections[0]?.close();

    await expect(closing).resolves.toMatchObject({ code: 1000 });
    await until(() => gate.closes.length === 1);
    expect(gate.closes).toEqual([{ runId: 'run-1', code: 1000 }]);
  });

  test('is absent until a gateway is given to the server', async () => {
    const server = await createServer({ auth: signedOut });
    servers.push(server);

    const response = await server.inject('/runner');

    expect(response.statusCode).toBe(404);
  });
});
