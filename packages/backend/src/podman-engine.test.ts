import { mkdtemp, rm } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  agentContainerRequest,
  ContainerNotFoundError,
  EngineError,
  type AgentContainerSpec,
  type EngineSettings,
} from './engine.js';
import { createPodmanEngine } from './podman-engine.js';

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

type Reply = (response: ServerResponse) => void;

const settings: EngineSettings = {
  dataVolume: 'cerebra-data',
  egressNetwork: 'cerebro-egress',
  internalNetwork: 'cerebro-internal',
};

const spec: AgentContainerSpec = {
  agentId: 'agent-1',
  environment: { CEREBRA_RUN_TOKEN: 'run-token-value' },
  image: 'localhost/cerebro-agent:latest',
  resources: { cpus: 1, memoryBytes: 512 * 1024 ** 2 },
  runId: 'run-1',
};

function json(status: number, body: unknown): Reply {
  return (response) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(body));
  };
}

function empty(status: number): Reply {
  return (response) => {
    response.writeHead(status);
    response.end();
  };
}

let directory: string;
let socketPath: string;
let server: Server;
let requests: RecordedRequest[];
let reply: Reply;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'cerebra-engine-'));
  socketPath = join(directory, 'api.sock');
  requests = [];
  reply = empty(500);
  server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      requests.push({
        body: text === '' ? undefined : (JSON.parse(text) as unknown),
        method: request.method ?? '',
        url: request.url ?? '',
      });
      reply(response);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { force: true, recursive: true });
});

function engine(requestTimeoutMs?: number) {
  return createPodmanEngine({ ...settings, requestTimeoutMs, socketPath });
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(Error);
  return outcome as Error;
}

describe('create', () => {
  test('creates the container through the compat API with the built request', async () => {
    reply = json(201, { Id: 'abc123', Warnings: [] });

    expect(await engine().create(spec)).toEqual({ id: 'abc123' });
    expect(requests).toEqual([
      {
        body: JSON.parse(
          JSON.stringify(agentContainerRequest(spec, settings).body),
        ),
        method: 'POST',
        url: '/v1.44/containers/create?name=cerebra-run-run-1',
      },
    ]);
  });

  test('surfaces the engine refusal without the environment values', async () => {
    reply = json(500, {
      message: 'bad spec: CEREBRA_RUN_TOKEN=run-token-value rejected',
    });

    const error = await failure(engine().create(spec));

    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({ operation: 'create', status: 500 });
    expect(error.message).toContain('bad spec');
    expect(error.message).not.toContain('run-token-value');
  });

  test('refuses an invalid specification before calling the engine', async () => {
    await failure(engine().create({ ...spec, runId: '../other' }));
    expect(requests).toEqual([]);
  });

  test('a reply without an id is an error, not a container', async () => {
    reply = json(201, { Warnings: [] });

    expect(await failure(engine().create(spec))).toBeInstanceOf(EngineError);
  });
});

describe('start, stop and remove', () => {
  test('call the compat endpoints for the container', async () => {
    reply = empty(204);
    const podman = engine();

    await podman.start('abc');
    await podman.stop('abc', { timeoutSeconds: 3 });
    await podman.stop('abc');
    await podman.remove('abc');

    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'POST /v1.44/containers/abc/start',
      'POST /v1.44/containers/abc/stop?t=3',
      'POST /v1.44/containers/abc/stop?t=10',
      'DELETE /v1.44/containers/abc',
    ]);
  });

  test('an already started or stopped container is not an error', async () => {
    reply = empty(304);

    await engine().start('abc');
    await engine().stop('abc');
  });

  test.each(['start', 'stop', 'remove'] as const)(
    '%s of a missing container is refused as not found',
    async (operation) => {
      reply = json(404, { message: 'no such container' });

      const error = await failure(engine()[operation]('abc'));

      expect(error).toBeInstanceOf(ContainerNotFoundError);
      expect(error).toMatchObject({ operation, status: 404 });
    },
  );

  test('a conflict is an engine error, not a missing container', async () => {
    reply = json(409, { message: 'container is running' });

    const error = await failure(engine().remove('abc'));

    expect(error).toBeInstanceOf(EngineError);
    expect(error).not.toBeInstanceOf(ContainerNotFoundError);
    expect(error.message).toContain('container is running');
  });

  test('encodes the container reference into the path', async () => {
    reply = empty(204);

    await engine().start('a/../b');

    expect(requests[0]?.url).toBe('/v1.44/containers/a%2F..%2Fb/start');
  });
});

describe('inspect', () => {
  const inspected = {
    Config: {
      Labels: { 'cerebra.agent': 'agent-1', 'cerebra.run': 'run-1' },
    },
    Id: 'abc',
    Name: '/cerebra-run-run-1',
    State: { ExitCode: 0, Status: 'running' },
  };

  test('reads the container state and its run', async () => {
    reply = json(200, inspected);

    expect(await engine().inspect('abc')).toEqual({
      agentId: 'agent-1',
      exitCode: null,
      id: 'abc',
      name: 'cerebra-run-run-1',
      runId: 'run-1',
      status: 'running',
    });
    expect(requests[0]).toMatchObject({
      method: 'GET',
      url: '/v1.44/containers/abc/json',
    });
  });

  test('reports the exit code of an exited container', async () => {
    reply = json(200, {
      ...inspected,
      Config: { Labels: null },
      State: { ExitCode: 137, Status: 'exited' },
    });

    expect(await engine().inspect('abc')).toMatchObject({
      agentId: null,
      exitCode: 137,
      runId: null,
      status: 'exited',
    });
  });

  test('a missing container is absent', async () => {
    reply = json(404, { message: 'no such container' });

    expect(await engine().inspect('abc')).toBeNull();
  });

  test.each([
    ['a server error', json(500, { message: 'database is locked' })],
    [
      'a malformed body',
      (response: ServerResponse) => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{not json');
      },
    ],
    [
      'an unrecognised status',
      json(200, { ...inspected, State: { ExitCode: 0, Status: 'stopping' } }),
    ],
    ['a body missing its state', json(200, { Id: 'abc', Name: '/x' })],
  ])('%s is an error, never an absent container', async (_case, answer) => {
    reply = answer;

    const error = await failure(engine().inspect('abc'));

    expect(error).toBeInstanceOf(EngineError);
    expect(error).not.toBeInstanceOf(ContainerNotFoundError);
  });
});

describe('an unavailable engine', () => {
  test('an unreachable socket is an error naming it', async () => {
    const podman = createPodmanEngine({
      ...settings,
      socketPath: join(directory, 'missing.sock'),
    });

    const error = await failure(podman.inspect('abc'));

    expect(error).toBeInstanceOf(EngineError);
    expect(error.message).toContain(join(directory, 'missing.sock'));
  });

  test('an engine that never answers times out', async () => {
    reply = () => undefined;

    const error = await failure(engine(100).inspect('abc'));

    expect(error).toBeInstanceOf(EngineError);
    expect(error.message).toContain('did not answer');
  });
});
