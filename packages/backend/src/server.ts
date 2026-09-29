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
import {
  CredentialInputError,
  CredentialNotFoundError,
  DuplicateDestinationError,
  type AgentCredentialDelivery,
  type CredentialScope,
  type CredentialService,
} from './credentials.js';
import {
  AgentHoldsWorkError,
  AgentNotFoundError,
  AgentTypeNotFoundError,
  DuplicateAgentNameError,
  InvalidAgentChangeError,
  InvalidAgentNameError,
  InvalidRoleSettingsError,
  type Fleet,
  type RunControl,
} from './fleet.js';
import type { AutomaticStartStatus, Dispatcher } from './dispatcher.js';
import { createInstanceService, type InstanceService } from './instance.js';
import { LimitInputError, type StartSettings } from './start-settings.js';
import { workItemStates, type Priority } from './lifecycle.js';
import type {
  NavigatorQueue,
  QueueActionResult,
  QueueDecision,
} from './navigator-queue.js';
import {
  GitHubAccessError,
  InvalidProjectPrefixError,
  InvalidProjectUrlError,
  ProjectMirrorError,
  type ProjectRegistration,
  type Project,
} from './projects.js';
import type { RunnerGateway } from './runner-gateway.js';
import type { McpEndpoint } from './mcp.js';
import {
  AgentUnavailableError,
  RunEndedError,
  RunNotFoundError,
  RunStartError,
  type RunUpdate,
  type Supervisor,
} from './supervisor.js';
import type { Conversation } from './runs.js';

/** What the conversation routes need of the run supervisor. */
export type ConversationControl = Pick<
  Supervisor,
  'answer' | 'read' | 'send' | 'stopRun' | 'subscribe'
>;

export interface ServerOptions {
  readonly auth: AuthService;
  readonly board?: Board;
  readonly credentials?: CredentialService;
  readonly fleet?: Fleet;
  readonly instance?: InstanceService;
  readonly projects?: ProjectRegistration;
  readonly listProjects?: () => Promise<readonly Project[]>;
  readonly queue?: NavigatorQueue;
  /** Absent when no container engine is configured; starting or stopping then answers 503. */
  readonly runs?: RunControl;
  /** Reads and feeds live conversations; absent alongside `runs`. */
  readonly conversations?: ConversationControl;
  /** Serves `/runner`, authenticated by run token rather than the navigator's session. */
  readonly runnerGateway?: RunnerGateway;
  /** Serves `/mcp`, the agents' board tools, authenticated by run token; absent alongside `runs`. */
  readonly mcp?: McpEndpoint;
  readonly uiDirectory?: string;
  /** The automatic-start pause and the run limits. */
  readonly startSettings?: StartSettings;
  /** Explains waiting work; absent when no container engine is configured. */
  readonly dispatcher?: Pick<Dispatcher, 'status'>;
  /** Called after every request that changed something, so waiting work can be looked at again. */
  readonly onMutation?: () => void;
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

const priorities: readonly string[] = ['P0', 'P1', 'P2', 'P3'];

function queueDecision(value: unknown): QueueDecision | null {
  const body = objectBody(value);
  if (body === null) {
    return null;
  }
  if (body.direction === 'reopen') {
    return { direction: 'reopen' };
  }
  if (typeof body.reason !== 'string' || body.reason.trim().length === 0) {
    return null;
  }
  const reason = body.reason.trim();
  if (body.direction === 'cancel') {
    return { direction: 'cancel', reason };
  }
  if (
    body.direction !== 'redirect' ||
    !boardRoutes.includes(body.to as BoardRoute) ||
    (body.priority !== undefined &&
      !priorities.includes(body.priority as string))
  ) {
    return null;
  }
  return {
    direction: 'redirect',
    ...(body.priority === undefined
      ? {}
      : { priority: body.priority as Priority }),
    reason,
    to: body.to as BoardRoute,
  };
}

function credentialBody(value: unknown): {
  readonly name: string;
  readonly projectId?: string;
  readonly scope: CredentialScope;
  readonly value: string;
} | null {
  const body = objectBody(value);
  if (
    body === null ||
    typeof body.name !== 'string' ||
    typeof body.value !== 'string' ||
    (body.scope !== 'instance' && body.scope !== 'project') ||
    (body.projectId !== undefined && typeof body.projectId !== 'string')
  ) {
    return null;
  }
  return {
    name: body.name,
    ...(typeof body.projectId === 'string'
      ? { projectId: body.projectId }
      : {}),
    scope: body.scope,
    value: body.value,
  };
}

function deliveriesBody(
  value: unknown,
): readonly AgentCredentialDelivery[] | null {
  const body = objectBody(value);
  if (body === null || !Array.isArray(body.deliveries)) {
    return null;
  }
  const deliveries: AgentCredentialDelivery[] = [];
  for (const entry of body.deliveries as unknown[]) {
    const delivery = objectBody(entry);
    if (
      delivery === null ||
      typeof delivery.credentialName !== 'string' ||
      typeof delivery.destination !== 'string' ||
      (delivery.delivery !== 'environment' && delivery.delivery !== 'file')
    ) {
      return null;
    }
    deliveries.push({
      credentialName: delivery.credentialName,
      delivery: delivery.delivery,
      destination: delivery.destination,
    });
  }
  return deliveries;
}

const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  // Radix's scroll lock injects a <style> element at runtime; scripts stay strict.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

export const createServer = async ({
  auth,
  board,
  conversations,
  credentials,
  fleet,
  instance = createInstanceService(),
  projects,
  listProjects,
  queue,
  runs,
  runnerGateway,
  mcp,
  uiDirectory = process.env.CEREBRA_UI_DIR,
  startSettings,
  dispatcher,
  onMutation,
}: ServerOptions): Promise<FastifyInstance> => {
  const server = Fastify();

  // The second layer behind rendering agent output as text (architecture §11).
  server.addHook('onSend', async (_request, reply) => {
    reply.header('content-security-policy', contentSecurityPolicy);
  });

  if (onMutation !== undefined) {
    server.addHook('onResponse', async (request, reply) => {
      if (
        request.method !== 'GET' &&
        request.method !== 'HEAD' &&
        reply.statusCode < 400
      ) {
        onMutation();
      }
    });
  }

  await server.register(websocket);
  runnerGateway?.routes(server);
  mcp?.routes(server);
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

  server.get('/api/projects', async (request, reply) => {
    if (listProjects === undefined) {
      return reply
        .status(503)
        .send({ error: 'Cerebra couldn’t load your projects. Try again.' });
    }
    try {
      return (await listProjects()).map(
        ({ id, owner, name, prefix, defaultBranch, remote }) => ({
          id,
          owner,
          name,
          prefix,
          defaultBranch,
          remote,
        }),
      );
    } catch {
      request.log.error('Could not read projects from the database.');
      return reply
        .status(503)
        .send({ error: 'Cerebra couldn’t load your projects. Try again.' });
    }
  });

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

  const credentialRoute =
    <P>(
      handler: (
        credentials: CredentialService,
        params: P,
        request: FastifyRequest,
        reply: FastifyReply,
      ) => Promise<unknown>,
    ) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (credentials === undefined) {
        return reply
          .status(503)
          .send({ error: 'Credentials are unavailable.' });
      }
      try {
        return await handler(credentials, request.params as P, request, reply);
      } catch (error) {
        if (error instanceof DuplicateDestinationError) {
          return reply.status(400).send({
            code: 'duplicate_destination',
            destination: error.destination,
            error: error.message,
          });
        }
        if (error instanceof CredentialInputError) {
          return reply.status(400).send({ error: error.message });
        }
        if (
          error instanceof CredentialNotFoundError ||
          error instanceof ProjectNotFoundError
        ) {
          return reply.status(404).send({ error: error.message });
        }
        // An unexpected failure may carry what was being saved; answer without it.
        return reply
          .status(500)
          .send({ error: 'Cerebra couldn’t update credentials.' });
      }
    };

  server.get(
    '/api/credentials',
    credentialRoute(async (credentials, _params, request) => {
      const query = objectBody(request.query) ?? {};
      return credentials.overview(
        typeof query.projectId === 'string' && query.projectId !== ''
          ? query.projectId
          : undefined,
      );
    }),
  );

  server.put(
    '/api/credentials',
    credentialRoute(async (credentials, _params, request, reply) => {
      const body = credentialBody(request.body);
      if (body === null) {
        return reply.status(400).send({ error: 'Enter the credential.' });
      }
      return credentials.save(body);
    }),
  );

  server.delete(
    '/api/credentials/:credentialId',
    credentialRoute<{ credentialId: string }>(
      async (credentials, { credentialId }, _request, reply) => {
        await credentials.remove(credentialId);
        return reply.status(204).send();
      },
    ),
  );

  server.get(
    '/api/projects/:projectId/agent-types/:agentType/credentials',
    credentialRoute<{ agentType: string; projectId: string }>(
      async (credentials, { agentType, projectId }) =>
        credentials.agentCredentials(projectId, agentType),
    ),
  );

  server.put(
    '/api/projects/:projectId/agent-types/:agentType/credentials',
    credentialRoute<{ agentType: string; projectId: string }>(
      async (credentials, { agentType, projectId }, request, reply) => {
        const deliveries = deliveriesBody(request.body);
        if (deliveries === null) {
          return reply
            .status(400)
            .send({ error: 'Choose each credential and how it is given.' });
        }
        await credentials.setAgentCredentials(projectId, agentType, deliveries);
        return credentials.agentCredentials(projectId, agentType);
      },
    ),
  );

  const queueRoute =
    (
      handler: (
        queue: NavigatorQueue,
        itemId: string,
        request: FastifyRequest,
        reply: FastifyReply,
      ) => Promise<unknown>,
    ) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (queue === undefined) {
        return reply
          .status(503)
          .send({ error: 'The navigator queue is unavailable.' });
      }
      try {
        return await handler(
          queue,
          (request.params as { itemId?: string }).itemId ?? '',
          request,
          reply,
        );
      } catch (error) {
        if (error instanceof WorkItemNotFoundError) {
          return reply.status(404).send({ error: error.message });
        }
        throw error;
      }
    };
  const queueResult = (reply: FastifyReply, result: QueueActionResult) =>
    result.ok
      ? { ok: true }
      : reply.status(409).send({ code: result.code, error: result.reason });

  server.get(
    '/api/navigator-queue',
    queueRoute(async (queue) => queue.list()),
  );

  server.post(
    '/api/navigator-queue/:itemId/answer',
    queueRoute(async (queue, itemId, request, reply) => {
      const body = objectBody(request.body);
      if (
        body === null ||
        typeof body.answer !== 'string' ||
        body.answer.trim().length === 0
      ) {
        return reply.status(400).send({ error: 'Enter an answer.' });
      }
      return queueResult(reply, await queue.answer(itemId, body.answer.trim()));
    }),
  );

  server.post(
    '/api/navigator-queue/:itemId/decision',
    queueRoute(async (queue, itemId, request, reply) => {
      const decision = queueDecision(request.body);
      if (decision === null) {
        return reply
          .status(400)
          .send({ error: 'Choose a direction and give a reason.' });
      }
      return queueResult(reply, await queue.decide(itemId, decision));
    }),
  );

  const fleetRoute =
    (
      handler: (
        fleet: Fleet,
        params: Record<string, string>,
        request: FastifyRequest,
        reply: FastifyReply,
      ) => Promise<unknown>,
    ) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (fleet === undefined) {
        return reply.status(503).send({ error: 'The fleet is unavailable.' });
      }
      try {
        return await handler(
          fleet,
          request.params as Record<string, string>,
          request,
          reply,
        );
      } catch (error) {
        return fleetError(reply, error);
      }
    };

  server.get(
    '/api/projects/:projectId/fleet',
    fleetRoute(async (fleet, { projectId }) => fleet.read(projectId)),
  );

  server.post(
    '/api/projects/:projectId/agents',
    fleetRoute(async (fleet, { projectId }, request, reply) => {
      const body = objectBody(request.body);
      if (body === null || typeof body.typeId !== 'string') {
        return reply.status(400).send({ error: 'Choose a role.' });
      }
      const person = await fleet.addAgent(projectId, {
        name: body.name,
        typeId: body.typeId,
      });
      return reply.status(201).send(person);
    }),
  );

  server.patch(
    '/api/agents/:agentId',
    fleetRoute(async (fleet, { agentId }, request, reply) => {
      const body = objectBody(request.body);
      if (body === null) {
        return reply.status(400).send({ error: 'Nothing to change.' });
      }
      return fleet.updateAgent(agentId, {
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(body.name === undefined ? {} : { name: body.name }),
      });
    }),
  );

  server.delete(
    '/api/agents/:agentId',
    fleetRoute(async (fleet, { agentId }, _request, reply) => {
      await fleet.removeAgent(agentId);
      return reply.status(204).send();
    }),
  );

  server.put(
    '/api/projects/:projectId/roles/:typeId',
    fleetRoute(async (fleet, { projectId, typeId }, request, reply) => {
      const body = objectBody(request.body);
      if (body === null) {
        return reply.status(400).send({ error: 'Choose the settings.' });
      }
      return fleet.saveRoleSettings(projectId, typeId, {
        model: body.model,
        startMode: body.startMode,
      });
    }),
  );

  for (const action of ['start', 'stop'] as const) {
    server.post(
      `/api/agents/:agentId/${action}`,
      async (request: FastifyRequest, reply: FastifyReply) => {
        if (runs === undefined) {
          return reply
            .status(503)
            .send({ error: 'Cerebra can’t run agents yet.' });
        }
        const { agentId } = request.params as { agentId: string };
        try {
          if (action === 'start') {
            const { runId } = await runs.start(agentId);
            return reply.status(202).send({ runId });
          }
          await runs.stop(agentId);
          return reply.status(202).send({ ok: true });
        } catch (error) {
          return fleetError(reply, error);
        }
      },
    );
  }

  const conversationRoute = (
    handler: (
      control: ConversationControl,
      runId: string,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<unknown>,
  ) =>
    async function route(request: FastifyRequest, reply: FastifyReply) {
      if (conversations === undefined) {
        return reply
          .status(503)
          .send({ error: 'Cerebra can’t run agents yet.' });
      }
      try {
        return await handler(
          conversations,
          (request.params as { runId: string }).runId,
          request,
          reply,
        );
      } catch (error) {
        return fleetError(reply, error);
      }
    };

  server.get(
    '/api/runs/:runId',
    conversationRoute(async (control, runId, _request, reply) => {
      const conversation = await control.read(runId);
      if (conversation === null) {
        throw new RunNotFoundError(runId);
      }
      return reply.send(conversationBody(conversation));
    }),
  );

  server.post(
    '/api/runs/:runId/messages',
    conversationRoute(async (control, runId, request, reply) => {
      const body = objectBody(request.body);
      if (typeof body?.text !== 'string' || body.text.trim() === '') {
        return reply.status(400).send({ error: 'Write a message.' });
      }
      await control.send(runId, body.text);
      return reply.status(202).send({ ok: true });
    }),
  );

  server.post(
    '/api/runs/:runId/answers',
    conversationRoute(async (control, runId, request, reply) => {
      const body = objectBody(request.body);
      const answers = objectBody(body?.answers);
      if (
        typeof body?.questionId !== 'string' ||
        answers === null ||
        Object.values(answers).some(
          (answer) => typeof answer !== 'string' || answer.trim() === '',
        ) ||
        Object.keys(answers).length === 0
      ) {
        return reply.status(400).send({ error: 'Choose an answer.' });
      }
      await control.answer(
        runId,
        body.questionId,
        answers as Record<string, string>,
      );
      return reply.status(202).send({ ok: true });
    }),
  );

  server.post(
    '/api/runs/:runId/stop',
    conversationRoute(async (control, runId, _request, reply) => {
      await control.stopRun(runId);
      return reply.status(202).send({ ok: true });
    }),
  );

  server.get(
    '/ws/runs/:runId',
    {
      preValidation: (request, reply) => authorize(auth, request, reply),
      websocket: true,
    },
    async (socket, request) => {
      if (conversations === undefined) {
        socket.close(1011, 'Cerebra can’t run agents yet.');
        return;
      }
      const { runId } = request.params as { runId: string };
      const after = Number(
        new URL(request.url, 'http://localhost').searchParams.get('after') ?? 0,
      );
      let last = Number.isInteger(after) && after > 0 ? after : 0;
      let replaying = true;
      const held: RunUpdate[] = [];
      const forward = (update: RunUpdate) => {
        if (update.type === 'event') {
          if (update.position <= last) return;
          last = update.position;
        }
        socket.send(JSON.stringify(updateBody(update)));
      };
      const unsubscribe = conversations.subscribe(runId, (update) => {
        if (replaying) {
          held.push(update);
        } else {
          forward(update);
        }
      });
      socket.on('close', unsubscribe);
      try {
        const conversation = await conversations.read(runId);
        if (conversation === null) {
          socket.close(4404, 'Conversation not found.');
          return;
        }
        for (const record of conversation.events) {
          forward({ type: 'event', ...record });
        }
        forward({
          failure: conversation.run.failure,
          state: conversation.run.state,
          type: 'state',
        });
        for (const update of held.splice(0)) {
          forward(update);
        }
        replaying = false;
      } catch {
        socket.close(1011, 'Cerebra couldn’t load this conversation.');
      }
    },
  );

  if (uiDirectory !== undefined) {
    server.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: 'Not found.' });
    });
  }

  const startSettingsRoute =
    (
      handler: (
        settings: StartSettings,
        params: Record<string, string>,
        request: FastifyRequest,
        reply: FastifyReply,
      ) => Promise<unknown>,
    ) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (startSettings === undefined) {
        return reply
          .status(503)
          .send({ error: 'Automatic starts are unavailable.' });
      }
      try {
        return await handler(
          startSettings,
          request.params as Record<string, string>,
          request,
          reply,
        );
      } catch (error) {
        if (error instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: error.message });
        }
        if (error instanceof LimitInputError) {
          return reply
            .status(400)
            .send({ code: 'invalid_limit', error: error.message });
        }
        throw error;
      }
    };

  server.get(
    '/api/projects/:projectId/automatic-starts',
    async (request, reply) => {
      if (dispatcher === undefined) {
        return reply
          .status(503)
          .send({ error: 'Automatic starts are unavailable.' });
      }
      const { projectId } = request.params as { projectId: string };
      try {
        return automaticStartBody(await dispatcher.status(projectId));
      } catch (error) {
        if (error instanceof ProjectNotFoundError) {
          return reply.status(404).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  server.put(
    '/api/projects/:projectId/automatic-starts',
    startSettingsRoute(async (settings, { projectId }, request, reply) => {
      const body = objectBody(request.body);
      if (body === null || typeof body.paused !== 'boolean') {
        return reply
          .status(400)
          .send({ error: 'Say whether automatic starts are paused.' });
      }
      await settings.setPaused(projectId ?? '', body.paused);
      return { paused: body.paused };
    }),
  );

  server.get(
    '/api/projects/:projectId/limits',
    startSettingsRoute(async (settings, { projectId }) =>
      settings.limits(projectId ?? ''),
    ),
  );

  server.put(
    '/api/projects/:projectId/limits',
    startSettingsRoute(async (settings, { projectId }, request) =>
      settings.setProjectLimit(
        projectId ?? '',
        objectBody(request.body)?.projectLimit,
      ),
    ),
  );

  server.get(
    '/api/settings/limits',
    startSettingsRoute(async (settings) => settings.limits()),
  );

  server.put(
    '/api/settings/limits',
    startSettingsRoute(async (settings, _params, request) =>
      settings.setInstanceLimit(objectBody(request.body)?.instanceLimit),
    ),
  );

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

function conversationBody({ events, run }: Conversation) {
  return {
    events: events.map((record) => updateBody({ type: 'event', ...record })),
    run: {
      agentId: run.agentId,
      agentName: run.agentName,
      agentRole: run.agentRole,
      endedAt: run.endedAt?.toISOString() ?? null,
      failure: run.failure,
      id: run.id,
      item: run.item,
      startedAt: run.startedAt.toISOString(),
      state: run.state,
    },
  };
}

function updateBody(update: RunUpdate) {
  return update.type === 'event'
    ? {
        createdAt: update.createdAt.toISOString(),
        event: update.event,
        position: update.position,
        type: 'event' as const,
      }
    : update;
}

function fleetError(reply: FastifyReply, error: unknown): FastifyReply {
  if (
    error instanceof ProjectNotFoundError ||
    error instanceof AgentNotFoundError ||
    error instanceof AgentTypeNotFoundError
  ) {
    return reply.status(404).send({ error: error.message });
  }
  if (
    error instanceof InvalidAgentNameError ||
    error instanceof InvalidAgentChangeError ||
    error instanceof InvalidRoleSettingsError
  ) {
    return reply.status(400).send({ error: error.message });
  }
  if (error instanceof DuplicateAgentNameError) {
    return reply
      .status(409)
      .send({ code: 'duplicate_name', error: error.message });
  }
  if (error instanceof RunNotFoundError) {
    return reply.status(404).send({ error: 'Conversation not found.' });
  }
  if (error instanceof RunEndedError) {
    return reply.status(409).send({ code: 'run_ended', error: error.message });
  }
  if (error instanceof AgentUnavailableError) {
    return reply.status(409).send({ code: error.code, error: error.message });
  }
  if (error instanceof RunStartError) {
    return reply.status(409).send({
      code: 'start_failed',
      error: error.message,
      runId: error.runId,
    });
  }
  if (error instanceof AgentHoldsWorkError) {
    return reply.status(409).send({ code: 'holds_work', error: error.message });
  }
  throw error;
}

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
    pathname === '/ws' ||
    pathname.startsWith('/ws/')
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

function automaticStartBody(status: AutomaticStartStatus) {
  return {
    limit: status.limit,
    paused: status.paused,
    running: status.running,
    waiting: status.waiting.map(({ itemId, reason }) => ({ itemId, reason })),
  };
}
