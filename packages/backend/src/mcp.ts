import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ToolDescriptor, ToolOutcome } from './board-tools.js';
import { hashRunToken } from './runner-gateway.js';

/** The board tools as the endpoint needs them, over any caller type. */
export interface McpTools<Caller> {
  list(caller: Caller): readonly ToolDescriptor[];
  call(caller: Caller, name: string, args: unknown): Promise<ToolOutcome>;
}

export interface McpEndpointOptions<Caller> {
  /** Answers the live run a token hash belongs to, or `null`. */
  readonly authenticate: (tokenHash: string) => Promise<Caller | null>;
  readonly tools: McpTools<Caller>;
}

export interface McpEndpoint {
  routes(server: FastifyInstance): void;
}

export const mcpPath = '/mcp';

const supportedVersions = ['2025-06-18', '2025-03-26', '2024-11-05'];
const invalidRequest = -32600;
const methodNotFound = -32601;
const invalidParams = -32602;
const internalError = -32603;

type RequestId = number | string;

/**
 * The backend's MCP server (architecture §5.4): stateless streamable HTTP, one JSON response per
 * POST, authenticated by the run token rather than the navigator's session.
 */
export function createMcpEndpoint<Caller>({
  authenticate,
  tools,
}: McpEndpointOptions<Caller>): McpEndpoint {
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
        let outcome: ToolOutcome;
        try {
          outcome = await tools.call(
            caller,
            params.name,
            params.arguments ?? {},
          );
        } catch {
          request.log.error(`The MCP tool ${String(params.name)} failed.`);
          return failure(id, internalError, 'Internal error');
        }
        const payload = outcome.ok
          ? outcome.value
          : { error: outcome.code, message: outcome.message };
        return success(id, {
          content: [{ text: JSON.stringify(payload), type: 'text' }],
          isError: !outcome.ok,
        });
      }
      default:
        return failure(id, methodNotFound, 'Method not found');
    }
  }

  return {
    routes(server) {
      server.post(mcpPath, handle);
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
