import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyInstance,
  type FastifyListenOptions,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { join } from 'node:path';
import { type AuthService, type AuthenticationResult } from './auth.js';
import {
  boardRoutes,
  boardSorts,
  ProjectNotFoundError,
  WorkItemNotFoundError,
  type Board,
  type BoardQuery,
  type BoardRoute,
} from './board.js';
import { createInstanceService, type InstanceService } from './instance.js';
import { workItemStates, type Priority } from './lifecycle.js';
import {
  GitHubAccessError,
  InvalidProjectPrefixError,
  InvalidProjectUrlError,
  ProjectMirrorError,
  type ProjectRegistration,
} from './projects.js';

export interface ServerOptions {
  readonly auth: AuthService;
  readonly board?: Board;
  readonly instance?: InstanceService;
  readonly projects?: ProjectRegistration;
  readonly uiDirectory?: string;
}

const sessionCookieName = 'cerebra_session';
const sessionCookieLifetimeSeconds = 30 * 24 * 60 * 60;
function projectRequestBody(value: unknown): {
  credential: string;
  prefix?: string;
  remote: string;
} | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const body = value as Record<string, unknown>;
  if (
    typeof body.credential !== 'string' ||
    typeof body.remote !== 'string' ||
    (body.prefix !== undefined && typeof body.prefix !== 'string')
  ) {
    return null;
  }

  return {
    credential: body.credential,
    ...(typeof body.prefix === 'string' ? { prefix: body.prefix } : {}),
    remote: body.remote,
  };
}

function projectError(
  error: unknown,
): { readonly error: string; readonly status: number } | null {
  if (
    error instanceof InvalidProjectUrlError ||
    error instanceof InvalidProjectPrefixError
  ) {
    return { error: error.message, status: 400 };
  }

  if (error instanceof GitHubAccessError) {
    return { error: error.message, status: 401 };
  }
  if (error instanceof ProjectMirrorError) {
    return { error: error.message, status: 502 };
  }
  return null;
}

function objectBody(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function boardQuery(value: unknown): BoardQuery | null {
  const query = objectBody(value) ?? {};
  const text = (key: string): string | undefined =>
    typeof query[key] === 'string' && query[key] !== ''
      ? (query[key] as string)
      : undefined;
  const state = text('state');
  const priority = text('priority');
  const sort = text('sort');
  const cursor = text('cursor');
  const snapshot = text('snapshot');
  if (
    (state !== undefined &&
      !(workItemStates as readonly string[]).includes(state)) ||
    (priority !== undefined &&
      !['P0', 'P1', 'P2', 'P3', 'none'].includes(priority)) ||
    (sort !== undefined && !(boardSorts as readonly string[]).includes(sort)) ||
    (cursor !== undefined && !/^\d+$/.test(cursor)) ||
    (snapshot !== undefined && !/^\d+$/.test(snapshot))
  ) {
    return null;
  }
  return Object.fromEntries(
    Object.entries({
      cursor,
      priority,
      search: text('search'),
      snapshot,
      sort,
      state,
    }).filter(([, entry]) => entry !== undefined),
  ) as BoardQuery;
}

function workItemBody(
  value: unknown,
): { readonly description: string; readonly title: string } | null {
  const body = objectBody(value);
  if (body === null || typeof body.title !== 'string') {
    return null;
  }
  return {
    description: typeof body.description === 'string' ? body.description : '',
    title: body.title,
  };
}

export const createServer = async ({
  auth,
  board,
  instance = createInstanceService(),
  projects,
  uiDirectory = process.env.CEREBRA_UI_DIR,
}: ServerOptions): Promise<FastifyInstance> => {
  const server = Fastify();

  await server.register(websocket);
  if (uiDirectory !== undefined) {
    await server.register(fastifyStatic, { root: join(uiDirectory) });
  }

  server.get('/health', async () => ({ status: 'ok' }));

  server.get('/api/auth/status', async (request, reply) => {
    const status = await auth.status(getSessionToken(request.headers.cookie));
    if (status.state === 'unauthenticated' && status.reason === 'expired') {
      clearSessionCookie(reply);
    }
    return status;
  });

  server.post('/api/auth/setup', async (request, reply) => {
    const result = await auth.setup(getPassword(request.body));
    return sendAuthenticationResult(result, reply, 201);
  });

  server.post('/api/auth/sign-in', async (request, reply) => {
    const result = await auth.signIn(getPassword(request.body));
    return sendAuthenticationResult(result, reply, 200);
  });

  server.post('/api/auth/sign-out', async (request, reply) => {
    await auth.signOut(getSessionToken(request.headers.cookie));
    clearSessionCookie(reply);
    return reply.status(204).send();
  });

  server.addHook('onRequest', async (request, reply) => {
    if (!requiresAuthentication(request.raw.url ?? request.url)) {
      return;
    }

    return authorize(auth, request, reply);
  });

  server.get('/api/instance', async () => ({
    status: 'running' as const,
    ...instance.getStatus(),
  }));

  server.post('/api/instance/update', async (_request, reply) => {
    try {
      return await instance.requestUpdate();
    } catch (error) {
      return reply.status(503).send({
        error:
          error instanceof Error ? error.message : 'The local update failed.',
      });
    }
  });

  server.get(
    '/ws',
    {
      preValidation: (request, reply) => authorize(auth, request, reply),
      websocket: true,
    },
    (socket) => {
      socket.on('message', (message) => socket.send(message));
    },
  );

  server.post('/api/projects/discover', async (request, reply) => {
    const body = projectRequestBody(request.body);
    if (body === null) {
      return reply
        .status(400)
        .send({ error: 'Enter a GitHub repository link.' });
    }
    if (projects === undefined) {
      return reply
        .status(503)
        .send({ error: 'Project registration is unavailable.' });
    }

    try {
      return await projects.discover(body);
    } catch (error) {
      const known = projectError(error);
      if (known !== null) {
        return reply.status(known.status).send({ error: known.error });
      }
      throw error;
    }
  });

  server.post('/api/projects', async (request, reply) => {
    const body = projectRequestBody(request.body);
    if (body === null || body.prefix === undefined) {
      return reply.status(400).send({ error: 'Enter the project settings.' });
    }
    if (projects === undefined) {
      return reply
        .status(503)
        .send({ error: 'Project registration is unavailable.' });
    }

    try {
      return reply.status(201).send(
        await projects.register({
          credential: body.credential,
          prefix: body.prefix,
          remote: body.remote,
        }),
      );
    } catch (error) {
      const known = projectError(error);
      if (known !== null) {
        return reply.status(known.status).send({ error: known.error });
      }
      throw error;
    }
  });

  const boardRoute =
    <P>(
      handler: (
        board: Board,
        params: P,
        request: FastifyRequest,
        reply: FastifyReply,
      ) => Promise<unknown>,
    ) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (board === undefined) {
        return reply
          .status(503)
          .send({ error: 'The project board is unavailable.' });
      }
      try {
        return await handler(board, request.params as P, request, reply);
      } catch (error) {
        if (
          error instanceof WorkItemNotFoundError ||
          error instanceof ProjectNotFoundError
        ) {
          return reply.status(404).send({ error: error.message });
        }
        throw error;
      }
    };

  server.get(
    '/api/projects/:projectId/work-items',
    boardRoute<{ projectId: string }>(
      async (board, { projectId }, request, reply) => {
        const query = boardQuery(request.query);
        return query === null
          ? reply.status(400).send({ error: 'Choose a valid board filter.' })
          : board.listWorkItems(projectId, query);
      },
    ),
  );

  server.get(
    '/api/projects/:projectId/work-items/arrivals',
    boardRoute<{ projectId: string }>(
      async (board, { projectId }, request, reply) => {
        const query = boardQuery(request.query);
        if (query === null || query.snapshot === undefined) {
          return reply.status(400).send({ error: 'Choose a valid snapshot.' });
        }
        return {
          count: await board.countArrivals(projectId, {
            ...query,
            snapshot: query.snapshot,
          }),
        };
      },
    ),
  );

  server.post(
    '/api/projects/:projectId/work-items',
    boardRoute<{ projectId: string }>(
      async (board, { projectId }, request, reply) => {
        const input = workItemBody(request.body);
        if (input === null || input.title.trim().length === 0) {
          return reply
            .status(400)
            .send({ error: 'Enter what needs to change.' });
        }
        const id = crypto.randomUUID();
        await board.createWorkItem({
          ...input,
          id,
          projectId,
          title: input.title.trim(),
        });
        return reply.status(201).send(await board.getWorkItem(id));
      },
    ),
  );

  server.get(
    '/api/work-items/:itemId',
    boardRoute<{ itemId: string }>(async (board, { itemId }) =>
      board.getWorkItem(itemId),
    ),
  );

  server.get(
    '/api/work-items/:itemId/history',
    boardRoute<{ itemId: string }>(async (board, { itemId }) =>
      board.getHistory(itemId),
    ),
  );

  server.get(
    '/api/work-items/:itemId/comments',
    boardRoute<{ itemId: string }>(async (board, { itemId }) =>
      board.listComments(itemId),
    ),
  );

  server.post(
    '/api/work-items/:itemId/comments',
    boardRoute<{ itemId: string }>(
      async (board, { itemId }, request, reply) => {
        const body = objectBody(request.body);
        if (
          body === null ||
          typeof body.body !== 'string' ||
          body.body.trim().length === 0
        ) {
          return reply.status(400).send({ error: 'Enter a comment.' });
        }
        return reply
          .status(201)
          .send(await board.addComment(itemId, body.body));
      },
    ),
  );

  server.post(
    '/api/work-items/:itemId/triage',
    boardRoute<{ itemId: string }>(
      async (board, { itemId }, request, reply) => {
        const body = objectBody(request.body);
        if (
          body === null ||
          !['P0', 'P1', 'P2', 'P3'].includes(body.priority as string) ||
          !boardRoutes.includes(body.to as BoardRoute)
        ) {
          return reply
            .status(400)
            .send({ error: 'Choose a priority and next step.' });
        }
        const result = await board.triage(
          itemId,
          body.priority as Priority,
          body.to as BoardRoute,
        );
        if (result.ok) {
          return board.getWorkItem(itemId);
        }
        return reply
          .status(409)
          .send(
            'code' in result
              ? { code: result.code, error: result.reason }
              : { error: result.reason },
          );
      },
    ),
  );

  server.post(
    '/api/work-items/:itemId/cancel',
    boardRoute<{ itemId: string }>(
      async (board, { itemId }, _request, reply) => {
        const result = await board.cancel(itemId);
        return result.ok
          ? board.getWorkItem(itemId)
          : reply.status(409).send({ error: result.reason });
      },
    ),
  );

  if (uiDirectory !== undefined) {
    server.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: 'Not found.' });
    });
  }

  return server;
};

export const startServer = async (
  options: FastifyListenOptions,
  serverOptions: ServerOptions,
): Promise<FastifyInstance> => {
  const server = await createServer(serverOptions);

  await server.listen(options);

  return server;
};

function getSessionToken(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined) {
    return undefined;
  }

  return cookieHeader
    .split(';')
    .map((cookie) => cookie.trim().split('=', 2))
    .find(([name]) => name === sessionCookieName)?.[1];
}

function getPassword(body: unknown): string {
  if (
    typeof body !== 'object' ||
    body === null ||
    !('password' in body) ||
    typeof body.password !== 'string'
  ) {
    return '';
  }
  return body.password;
}

function requiresAuthentication(url: string): boolean {
  const pathname = new URL(url, 'http://localhost').pathname;
  return (
    (pathname.startsWith('/api/') && !pathname.startsWith('/api/auth/')) ||
    pathname === '/ws'
  );
}

async function authorize(
  auth: AuthService,
  request: { headers: { cookie?: string } },
  reply: {
    header(name: string, value: string): unknown;
    status(statusCode: number): { send(payload: unknown): unknown };
  },
): Promise<unknown> {
  const status = await auth.status(getSessionToken(request.headers.cookie));
  if (status.state === 'authenticated') {
    return;
  }

  const reason =
    status.state === 'unauthenticated' ? status.reason : 'signed-out';
  if (reason === 'expired') {
    clearSessionCookie(reply);
  }
  return reply.status(401).send({
    error: 'Sign in to continue.',
    reason,
  });
}

function clearSessionCookie(reply: {
  header(name: string, value: string): unknown;
}): void {
  reply.header(
    'set-cookie',
    `${sessionCookieName}=; HttpOnly; Max-Age=0; Path=/; SameSite=Strict`,
  );
}

function sendAuthenticationResult(
  result: AuthenticationResult,
  reply: {
    header(name: string, value: string): unknown;
    status(statusCode: number): { send(payload: unknown): unknown };
  },
  successStatus: number,
): unknown {
  if (!result.ok) {
    return reply
      .status(
        result.reason === 'invalid-password'
          ? 400
          : result.reason === 'already-configured'
            ? 409
            : 401,
      )
      .send({
        error:
          result.reason === 'invalid-password'
            ? 'Use at least 8 characters.'
            : 'That password didn’t match. Try again.',
      });
  }

  reply.header(
    'set-cookie',
    `${sessionCookieName}=${result.sessionToken}; HttpOnly; Max-Age=${sessionCookieLifetimeSeconds}; Path=/; SameSite=Strict`,
  );
  return reply.status(successStatus).send({ state: 'authenticated' });
}
