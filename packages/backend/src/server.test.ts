import {
  CredentialInputError,
  CredentialNotFoundError,
  DuplicateDestinationError,
  ProjectNotFoundError,
  WorkItemNotFoundError,
  createServer,
  type CredentialService,
  type Board,
  GitHubAccessError,
  ProjectMirrorError,
  startServer,
  type InstanceService,
  type NavigatorQueue,
  type ProjectRegistration,
} from '@cerebra/backend';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createNodeServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('every response carries a strict Content-Security-Policy', async () => {
  const uiDirectory = await mkdtemp(join(tmpdir(), 'cerebra-ui-'));
  try {
    await writeFile(join(uiDirectory, 'index.html'), '<!doctype html>');
    const server = await createServer({ auth: authenticatedAuth, uiDirectory });
    servers.push(server);

    for (const url of ['/', '/health', '/api/projects', '/api/nothing-here']) {
      const policy = String(
        (await server.inject(url)).headers['content-security-policy'],
      );
      const directives = new Map(
        policy.split(';').map((directive) => {
          const [name = '', ...sources] = directive.trim().split(/\s+/);
          return [name, sources.join(' ')] as const;
        }),
      );
      expect(Object.fromEntries(directives), url).toEqual({
        'default-src': "'self'",
        'script-src': "'self'",
        'style-src': "'self' 'unsafe-inline'",
        'img-src': "'self' data:",
        'connect-src': "'self'",
        'object-src': "'none'",
        'base-uri': "'none'",
        'frame-ancestors': "'none'",
        'form-action': "'self'",
      });
    }
  } finally {
    await rm(uiDirectory, { force: true, recursive: true });
  }
});

test('lists saved projects without returning credential fields', async () => {
  const project = {
    id: 'project-1',
    owner: 'acme',
    name: 'website',
    prefix: 'WEB',
    defaultBranch: 'main',
    remote: 'https://github.com/acme/website.git',
    github_token_ciphertext: 'must-not-leave-the-server',
  };
  const server = await createServer({
    auth: authenticatedAuth,
    listProjects: async () => [project],
  });
  servers.push(server);
  const response = await server.inject('/api/projects');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual([
    {
      id: project.id,
      owner: project.owner,
      name: project.name,
      prefix: project.prefix,
      defaultBranch: project.defaultBranch,
      remote: project.remote,
    },
  ]);
  expect(response.body).not.toContain('must-not-leave-the-server');
});

test('failed project reads are unavailable, not an empty list', async () => {
  const server = await createServer({
    auth: authenticatedAuth,
    listProjects: async () => {
      throw new Error('database unavailable');
    },
  });
  servers.push(server);
  const response = await server.inject('/api/projects');
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({
    error: 'Cerebra couldn’t load your projects. Try again.',
  });
});

test('requires authentication before listing projects', async () => {
  const server = await createServer({
    auth: {
      ...authenticatedAuth,
      status: async () => ({
        state: 'unauthenticated',
        reason: 'signed-out',
      }),
    },
    listProjects: async () => {
      throw new Error('Must not be reached');
    },
  });
  servers.push(server);
  expect((await server.inject('/api/projects')).statusCode).toBe(401);
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
  const server = await createServer({ auth: authenticatedAuth, projects });
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
  const server = await createServer({ auth: authenticatedAuth, projects });
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

test('forwards the actionable clone failure reason to the client', async () => {
  const reason =
    'The repository could not be copied because storage is full. Free space in the Podman machine, then try again.';
  const server = await createServer({
    auth: authenticatedAuth,
    projects: {
      discover: async () => {
        throw new Error('Not exercised');
      },
      register: async () => {
        throw new ProjectMirrorError(reason);
      },
    },
  });
  servers.push(server);
  const response = await server.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      credential: 'secret',
      prefix: 'SITE',
      remote: 'https://github.com/acme/website',
    },
  });
  expect(response.statusCode).toBe(502);
  expect(response.json()).toEqual({ error: reason });
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

const boardItem = {
  createdAt: new Date('2026-09-29T00:00:00.000Z'),
  description: '',
  id: 'item-1',
  priority: null,
  state: 'new' as const,
  title: 'Show the board',
  updatedAt: new Date('2026-09-29T00:00:00.000Z'),
};

function fakeBoard(overrides: Partial<Board> = {}): Board {
  const unused = async () => {
    throw new Error('Not exercised');
  };
  return {
    addComment: unused,
    cancel: unused,
    claim: unused,
    countArrivals: unused,
    createProject: unused,
    createWorkItem: unused,
    getHistory: unused,
    getWorkItem: unused,
    listComments: unused,
    listWorkItems: unused,
    transition: unused,
    triage: unused,
    ...overrides,
  } as Board;
}

test('lists a board page with its query and snapshot', async () => {
  const queries: unknown[] = [];
  const server = await createServer({
    auth: authenticatedAuth,
    board: fakeBoard({
      listWorkItems: async (projectId, query) => {
        queries.push({ projectId, query });
        return {
          items: [boardItem],
          nextCursor: '25',
          snapshot: '7',
          total: 26,
        };
      },
    }),
  });
  servers.push(server);

  const response = await server.inject(
    '/api/projects/project-1/work-items?search=board&state=new&priority=none&sort=oldest&cursor=25&snapshot=7',
  );

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    items: [
      {
        ...boardItem,
        createdAt: '2026-09-29T00:00:00.000Z',
        updatedAt: '2026-09-29T00:00:00.000Z',
      },
    ],
    nextCursor: '25',
    snapshot: '7',
    total: 26,
  });
  expect(queries).toEqual([
    {
      projectId: 'project-1',
      query: {
        cursor: '25',
        priority: 'none',
        search: 'board',
        snapshot: '7',
        sort: 'oldest',
        state: 'new',
      },
    },
  ]);
});

test('refuses an unknown list filter rather than answering with nothing', async () => {
  const server = await createServer({
    auth: authenticatedAuth,
    board: fakeBoard(),
  });
  servers.push(server);

  const response = await server.inject(
    '/api/projects/project-1/work-items?sort=sideways',
  );

  expect(response.statusCode).toBe(400);
});

test('counts matching arrivals after a snapshot', async () => {
  const server = await createServer({
    auth: authenticatedAuth,
    board: fakeBoard({
      countArrivals: async (_projectId, query) =>
        query.snapshot === '7' && query.search === 'x' ? 2 : 0,
    }),
  });
  servers.push(server);

  const response = await server.inject(
    '/api/projects/project-1/work-items/arrivals?snapshot=7&search=x',
  );

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ count: 2 });
});

test('returns an unavailable route as an explicit refusal', async () => {
  const server = await createServer({
    auth: authenticatedAuth,
    board: fakeBoard({
      triage: async () => ({
        code: 'route_unavailable',
        ok: false,
        reason: 'That next step is not available for this project.',
      }),
    }),
  });
  servers.push(server);

  const response = await server.inject({
    method: 'POST',
    payload: { priority: 'P1', to: 'design_ready' },
    url: '/api/work-items/item-1/triage',
  });

  expect(response.statusCode).toBe(409);
  expect(response.json()).toEqual({
    code: 'route_unavailable',
    error: 'That next step is not available for this project.',
  });
});

test('answers an unknown work item with 404, never an empty body', async () => {
  const missing = async () => {
    throw new WorkItemNotFoundError('item-9');
  };
  const server = await createServer({
    auth: authenticatedAuth,
    board: fakeBoard({
      getHistory: missing,
      getWorkItem: missing,
      listComments: missing,
    }),
  });
  servers.push(server);

  for (const url of [
    '/api/work-items/item-9',
    '/api/work-items/item-9/history',
    '/api/work-items/item-9/comments',
  ]) {
    const response = await server.inject(url);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: 'Work item item-9 does not exist.',
    });
  }
});

test('answers every board read with 503 when no board is wired', async () => {
  const server = await createServer({ auth: authenticatedAuth });
  servers.push(server);

  const response = await server.inject('/api/projects/project-1/work-items');

  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({
    error: 'The project board is unavailable.',
  });
});

function fakeQueue(overrides: Partial<NavigatorQueue> = {}): NavigatorQueue {
  const unused = async () => {
    throw new Error('Not exercised');
  };
  return { answer: unused, decide: unused, list: unused, ...overrides };
}

test('lists what waits on the navigator across projects', async () => {
  const server = await createServer({
    auth: authenticatedAuth,
    queue: fakeQueue({
      list: async () => ({
        entries: [
          {
            askedBy: 'Groomer',
            availableRoutes: ['build_ready'],
            description: '',
            id: 'item-1',
            kind: 'question',
            priority: 'P1',
            projectId: 'project-1',
            projectName: 'acme/alpha',
            since: new Date('2026-09-29T00:00:00.000Z'),
            title: 'Show the queue',
            waitingReason: 'Which release?',
          },
        ],
        total: 1,
      }),
    }),
  });
  servers.push(server);

  const response = await server.inject('/api/navigator-queue');

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    entries: [{ id: 'item-1', since: '2026-09-29T00:00:00.000Z' }],
    total: 1,
  });
});

test('answers a question and refuses an empty answer', async () => {
  const answers: unknown[] = [];
  const server = await createServer({
    auth: authenticatedAuth,
    queue: fakeQueue({
      answer: async (itemId, answer) => {
        answers.push({ answer, itemId });
        return { ok: true };
      },
    }),
  });
  servers.push(server);

  const empty = await server.inject({
    method: 'POST',
    payload: { answer: '  ' },
    url: '/api/navigator-queue/item-1/answer',
  });
  const answered = await server.inject({
    method: 'POST',
    payload: { answer: 'The next one.' },
    url: '/api/navigator-queue/item-1/answer',
  });

  expect(empty.statusCode).toBe(400);
  expect(answered.statusCode).toBe(200);
  expect(answered.json()).toEqual({ ok: true });
  expect(answers).toEqual([{ answer: 'The next one.', itemId: 'item-1' }]);
});

test('passes a decision through and requires a reason to cancel or redirect', async () => {
  const decisions: unknown[] = [];
  const server = await createServer({
    auth: authenticatedAuth,
    queue: fakeQueue({
      decide: async (itemId, decision) => {
        decisions.push({ decision, itemId });
        return { ok: true };
      },
    }),
  });
  servers.push(server);

  for (const payload of [
    { direction: 'cancel' },
    { direction: 'redirect', reason: ' ', to: 'build_ready' },
    { direction: 'redirect', reason: 'Why', to: 'merging' },
    { direction: 'redirect', priority: 'P9', reason: 'Why', to: 'build_ready' },
    { direction: 'sideways' },
  ]) {
    const response = await server.inject({
      method: 'POST',
      payload,
      url: '/api/navigator-queue/item-1/decision',
    });
    expect(response.statusCode).toBe(400);
  }

  for (const payload of [
    { direction: 'reopen' },
    { direction: 'cancel', reason: 'Not needed' },
    {
      direction: 'redirect',
      priority: 'P2',
      reason: 'Build it',
      to: 'build_ready',
    },
  ]) {
    const response = await server.inject({
      method: 'POST',
      payload,
      url: '/api/navigator-queue/item-1/decision',
    });
    expect(response.statusCode).toBe(200);
  }

  expect(decisions).toEqual([
    { decision: { direction: 'reopen' }, itemId: 'item-1' },
    {
      decision: { direction: 'cancel', reason: 'Not needed' },
      itemId: 'item-1',
    },
    {
      decision: {
        direction: 'redirect',
        priority: 'P2',
        reason: 'Build it',
        to: 'build_ready',
      },
      itemId: 'item-1',
    },
  ]);
});

test('returns a queue refusal as a conflict and an unknown item as 404', async () => {
  const server = await createServer({
    auth: authenticatedAuth,
    queue: fakeQueue({
      answer: async () => {
        throw new WorkItemNotFoundError('item-9');
      },
      decide: async () => ({
        code: 'not_waiting',
        ok: false,
        reason: 'This work no longer waits on the navigator.',
      }),
    }),
  });
  servers.push(server);

  const refused = await server.inject({
    method: 'POST',
    payload: { direction: 'reopen' },
    url: '/api/navigator-queue/item-1/decision',
  });
  const missing = await server.inject({
    method: 'POST',
    payload: { answer: 'Yes' },
    url: '/api/navigator-queue/item-9/answer',
  });

  expect(refused.statusCode).toBe(409);
  expect(refused.json()).toEqual({
    code: 'not_waiting',
    error: 'This work no longer waits on the navigator.',
  });
  expect(missing.statusCode).toBe(404);
});

test('answers the queue with 503 when no queue is wired', async () => {
  const server = await createServer({ auth: authenticatedAuth });
  servers.push(server);

  const response = await server.inject('/api/navigator-queue');

  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({
    error: 'The navigator queue is unavailable.',
  });
});

function credentialService(
  overrides: Partial<CredentialService> = {},
): CredentialService {
  return {
    agentCredentials: async (_projectId, agentType) => ({
      agentType,
      available: ['Deploy key'],
      entries: [],
    }),
    overview: async () => ({
      attention: [],
      instanceCredentials: [],
      project: null,
      projectCredentials: [],
    }),
    recordInjectionFailure: async () => undefined,
    remove: async () => undefined,
    resolveForRun: async () => ({ ok: false, problems: [] }),
    save: async ({ name }) => ({ name, replaced: false }),
    setAgentCredentials: async () => undefined,
    ...overrides,
  };
}

test('lists credentials for the project in context', async () => {
  const projectIds: Array<string | undefined> = [];
  const server = await createServer({
    auth: authenticatedAuth,
    credentials: credentialService({
      overview: async (projectId) => {
        projectIds.push(projectId);
        return {
          attention: [],
          instanceCredentials: [],
          project: projectId ? { id: projectId, name: 'acme/app' } : null,
          projectCredentials: [],
        };
      },
    }),
  });
  servers.push(server);

  const withProject = await server.inject('/api/credentials?projectId=p1');
  const without = await server.inject('/api/credentials');

  expect(withProject.statusCode).toBe(200);
  expect(withProject.json().project).toEqual({ id: 'p1', name: 'acme/app' });
  expect(without.json().project).toBeNull();
  expect(projectIds).toEqual(['p1', undefined]);
});

test('says credentials are unavailable rather than listing none', async () => {
  const server = await createServer({ auth: authenticatedAuth });
  servers.push(server);

  const response = await server.inject('/api/credentials');

  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ error: 'Credentials are unavailable.' });
});

test('answers an unknown project with not found', async () => {
  const server = await createServer({
    auth: authenticatedAuth,
    credentials: credentialService({
      overview: async (projectId) => {
        throw new ProjectNotFoundError(projectId ?? '');
      },
    }),
  });
  servers.push(server);

  const response = await server.inject('/api/credentials?projectId=gone');

  expect(response.statusCode).toBe(404);
});

test('saves a credential without ever returning its value', async () => {
  const saved: unknown[] = [];
  const server = await createServer({
    auth: authenticatedAuth,
    credentials: credentialService({
      save: async (input) => {
        saved.push(input);
        return { name: input.name, replaced: true };
      },
    }),
  });
  servers.push(server);

  const response = await server.inject({
    method: 'PUT',
    payload: {
      name: 'Deploy key',
      projectId: 'p1',
      scope: 'project',
      value: 'super-secret-value',
    },
    url: '/api/credentials',
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ name: 'Deploy key', replaced: true });
  expect(response.body).not.toContain('super-secret-value');
  expect(saved).toEqual([
    {
      name: 'Deploy key',
      projectId: 'p1',
      scope: 'project',
      value: 'super-secret-value',
    },
  ]);
});

test('refuses a malformed or invalid credential without echoing it', async () => {
  const server = await createServer({
    auth: authenticatedAuth,
    credentials: credentialService({
      save: async () => {
        throw new CredentialInputError('Paste the value.');
      },
    }),
  });
  servers.push(server);

  const malformed = await server.inject({
    method: 'PUT',
    payload: { name: 'Deploy key', scope: 'nowhere', value: 'secret-a' },
    url: '/api/credentials',
  });
  const invalid = await server.inject({
    method: 'PUT',
    payload: { name: 'Deploy key', scope: 'instance', value: 'secret-b' },
    url: '/api/credentials',
  });

  expect(malformed.statusCode).toBe(400);
  expect(malformed.body).not.toContain('secret-a');
  expect(invalid.statusCode).toBe(400);
  expect(invalid.json()).toEqual({ error: 'Paste the value.' });
  expect(invalid.body).not.toContain('secret-b');
});

test('never answers with a value even when saving fails unexpectedly', async () => {
  const server = await createServer({
    auth: authenticatedAuth,
    credentials: credentialService({
      save: async (input) => {
        throw new Error(`database refused ${input.value}`);
      },
    }),
  });
  servers.push(server);

  const response = await server.inject({
    method: 'PUT',
    payload: { name: 'Deploy key', scope: 'instance', value: 'secret-c' },
    url: '/api/credentials',
  });

  expect(response.statusCode).toBe(500);
  expect(response.body).not.toContain('secret-c');
});

test('removes a credential, and says when it is already gone', async () => {
  const removed: string[] = [];
  const server = await createServer({
    auth: authenticatedAuth,
    credentials: credentialService({
      remove: async (id) => {
        if (id === 'gone') {
          throw new CredentialNotFoundError();
        }
        removed.push(id);
      },
    }),
  });
  servers.push(server);

  const ok = await server.inject({
    method: 'DELETE',
    url: '/api/credentials/c1',
  });
  const gone = await server.inject({
    method: 'DELETE',
    url: '/api/credentials/gone',
  });

  expect(ok.statusCode).toBe(204);
  expect(removed).toEqual(['c1']);
  expect(gone.statusCode).toBe(404);
});

test('reads and saves an agent type’s credentials', async () => {
  const saved: unknown[] = [];
  const server = await createServer({
    auth: authenticatedAuth,
    credentials: credentialService({
      setAgentCredentials: async (projectId, agentType, deliveries) => {
        saved.push({ agentType, deliveries, projectId });
      },
    }),
  });
  servers.push(server);

  const read = await server.inject(
    '/api/projects/p1/agent-types/producer/credentials',
  );
  const write = await server.inject({
    method: 'PUT',
    payload: {
      deliveries: [
        {
          credentialName: 'Deploy key',
          delivery: 'environment',
          destination: 'DEPLOY',
        },
      ],
    },
    url: '/api/projects/p1/agent-types/producer/credentials',
  });

  expect(read.statusCode).toBe(200);
  expect(read.json().agentType).toBe('producer');
  expect(write.statusCode).toBe(200);
  expect(write.json().agentType).toBe('producer');
  expect(saved).toEqual([
    {
      agentType: 'producer',
      deliveries: [
        {
          credentialName: 'Deploy key',
          delivery: 'environment',
          destination: 'DEPLOY',
        },
      ],
      projectId: 'p1',
    },
  ]);
});

test('names a duplicate destination so the dialog can mark it', async () => {
  const server = await createServer({
    auth: authenticatedAuth,
    credentials: credentialService({
      setAgentCredentials: async () => {
        throw new DuplicateDestinationError('GH_TOKEN');
      },
    }),
  });
  servers.push(server);

  const response = await server.inject({
    method: 'PUT',
    payload: {
      deliveries: [
        {
          credentialName: 'Deploy key',
          delivery: 'environment',
          destination: 'GH_TOKEN',
        },
      ],
    },
    url: '/api/projects/p1/agent-types/producer/credentials',
  });
  const malformed = await server.inject({
    method: 'PUT',
    payload: { deliveries: [{ delivery: 'carrier-pigeon' }] },
    url: '/api/projects/p1/agent-types/producer/credentials',
  });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({
    code: 'duplicate_destination',
    destination: 'GH_TOKEN',
    error:
      '“GH_TOKEN” is already used. Choose a different name or change the existing credential.',
  });
  expect(malformed.statusCode).toBe(400);
});
