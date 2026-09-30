import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ToolDescriptor, ToolOutcome } from './board-tools.js';
import { hashRunToken } from './runner-gateway.js';

/** The board tools as the endpoint needs them, over any caller type. */
export interface McpTools<Caller> {
  list(caller: Caller): readonly ToolDescriptor[];
  call(
    caller: Caller,
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<ToolOutcome>;
}

export interface McpEndpointOptions<Caller> {
  /** Answers the live run a token hash belongs to, or `null`. */
  readonly authenticate: (tokenHash: string) => Promise<Caller | null>;
  readonly tools: McpTools<Caller>;
  /**
   * When a tool call still runs after `afterMs`, its answer comes as an event stream with a
   * comment every `everyMs`, so no proxy or client drops a call that waits for the navigator.
   */
  readonly keepAlive?: { readonly afterMs: number; readonly everyMs: number };
}

export interface McpEndpoint {
  routes(server: FastifyInstance): void;
}

export const mcpPath = '/mcp';

const supportedVersions = ['2025-06-18', '2025-03-26', '2024-11-05'];
const parseError = -32700;
const invalidRequest = -32600;
const methodNotFound = -32601;
const invalidParams = -32602;
const internalError = -32603;

type RequestId = number | string;

/**
 * The backend's MCP server (architecture §5.4): stateless streamable HTTP, one response per POST,
 * authenticated by the run token rather than the navigator's session. The response is JSON, or an
 * event stream for a tool call that waits long, such as a plan waiting for approval.
 */
export function createMcpEndpoint<Caller>({
  authenticate,
  keepAlive = { afterMs: 20_000, everyMs: 25_000 },
  tools,
}: McpEndpointOptions<Caller>): McpEndpoint {
  async function callTool(
    request: FastifyRequest,
    reply: FastifyReply,
    id: RequestId,
    caller: Caller,
    name: string,
    args: unknown,
  ): Promise<unknown> {
    // The client going away abandons the call, so a waiting plan stops waiting for it.
    const abandoned = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableFinished) abandoned.abort();
    };
    reply.raw.on('close', onClose);
    const answer = tools
      .call(caller, name, args, abandoned.signal)
      .then(
        (outcome) => {
          const payload = outcome.ok
            ? outcome.value
            : { error: outcome.code, message: outcome.message };
          return success(id, {
            content: [{ text: JSON.stringify(payload), type: 'text' }],
            isError: !outcome.ok,
          });
        },
        () => {
          request.log.error(`The MCP tool ${name} failed.`);
          return failure(id, internalError, 'Internal error');
        },
      )
      .finally(() => reply.raw.off('close', onClose));

    const streams = /text\/event-stream/.test(request.headers.accept ?? '');
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => resolve('late'), keepAlive.afterMs);
    });
    const first = streams ? await Promise.race([answer, late]) : await answer;
    clearTimeout(timer);
    if (first !== 'late') return first;

    reply.hijack();
    reply.raw.writeHead(200, {
      'cache-control': 'no-cache',
      'content-type': 'text/event-stream',
    });
    reply.raw.write(': waiting\n\n');
    const beat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': waiting\n\n');
    }, keepAlive.everyMs);
    abandoned.signal.addEventListener('abort', () => clearInterval(beat), {
      once: true,
    });
    const message = await answer;
    clearInterval(beat);
    if (!abandoned.signal.aborted) {
      reply.raw.end(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    }
    return reply;
  }

  async function handle(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> {
    // MCP's guard against DNS rebinding: runners never send an Origin, browsers always do.
    if (request.headers.origin !== undefined) {
      return reply.status(403).send({ error: 'Browsers may not call /mcp.' });
    }
    const token = bearer(request.headers.authorization);
    const caller =
      token === undefined ? null : await authenticate(hashRunToken(token));
    if (caller === null) {
      return reply
        .status(401)
        .header('www-authenticate', 'Bearer')
        .send({ error: 'Unknown run token.' });
    }

    const message = request.body;
    if (!isObject(message)) {
      return reply
        .status(400)
        .send(failure(null, invalidRequest, 'Invalid Request'));
    }
    const id = requestId(message.id);
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      if (
        message.jsonrpc === '2.0' &&
        ('result' in message || 'error' in message)
      ) {
        return reply.status(202).send();
      }
      return reply
        .status(400)
        .send(failure(id ?? null, invalidRequest, 'Invalid Request'));
    }
    if (id === undefined) {
      return reply.status(202).send();
    }

    const params = isObject(message.params) ? message.params : {};
    switch (message.method) {
      case 'initialize':
        return success(id, {
          capabilities: { tools: {} },
          protocolVersion: supportedVersions.includes(
            String(params.protocolVersion),
          )
            ? params.protocolVersion
            : supportedVersions[0],
          serverInfo: { name: 'cerebra', version: '0.0.0' },
        });
      case 'ping':
        return success(id, {});
      case 'tools/list':
        return success(id, { tools: tools.list(caller) });
      case 'tools/call': {
        if (typeof params.name !== 'string') {
          return failure(id, invalidParams, 'tools/call needs a tool name.');
        }
        return callTool(
          request,
          reply,
          id,
          caller,
          params.name,
          params.arguments ?? {},
        );
      }
      default:
        return failure(id, methodNotFound, 'Method not found');
    }
  }

  return {
    routes(server) {
      server.post(
        mcpPath,
        {
          // A body Fastify cannot parse still gets a JSON-RPC answer, not Fastify's own.
          errorHandler: (error, _request, reply) => {
            const status = (error as { statusCode?: number }).statusCode;
            if (status === 400 || status === 415) {
              return reply
                .status(status)
                .send(failure(null, parseError, 'Parse error'));
            }
            throw error;
          },
        },
        handle,
      );
      server.route({
        handler: async (_request, reply) =>
          reply.status(405).header('allow', 'POST').send(),
        method: ['GET', 'DELETE'],
        url: mcpPath,
      });
    },
  };
}

function bearer(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return match?.[1];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestId(value: unknown): RequestId | undefined {
  return typeof value === 'string' || typeof value === 'number'
    ? value
    : undefined;
}

function success(id: RequestId, result: unknown) {
  return { id, jsonrpc: '2.0', result };
}

function failure(id: RequestId | null, code: number, message: string) {
  return { error: { code, message }, id, jsonrpc: '2.0' };
}
