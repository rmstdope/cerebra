import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, test } from 'vitest';

import type { ToolOutcome } from './board-tools.js';
import { createMcpEndpoint } from './mcp.js';
import { hashRunToken } from './runner-gateway.js';

interface FakeCaller {
  readonly runId: string;
}

const token = 'run-token';
let server: FastifyInstance | undefined;
const calls: { args: unknown; caller: FakeCaller; name: string }[] = [];

async function serve(
  outcome: (name: string) => Promise<ToolOutcome> = async () => ({
    ok: true,
    value: { id: 'item-1', state: 'build_ready' },
  }),
): Promise<FastifyInstance> {
  calls.length = 0;
  server = Fastify();
  createMcpEndpoint<FakeCaller>({
    authenticate: async (tokenHash) =>
      tokenHash === hashRunToken(token) ? { runId: 'run-1' } : null,
    tools: {
      list: () => [
        {
          description: 'Read one work item.',
          inputSchema: { properties: {}, type: 'object' },
          name: 'get_item',
        },
      ],
      async call(caller, name, args) {
        calls.push({ args, caller, name });
        return outcome(name);
      },
    },
  }).routes(server);
  return server;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function rpc(
  app: FastifyInstance,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.inject({
    body: body as object,
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...headers,
    },
    method: 'POST',
    url: '/mcp',
  });
}

describe('the MCP endpoint', () => {
  test('initializes with a protocol version it speaks', async () => {
    const app = await serve();

    const known = await rpc(app, {
      id: 1,
      jsonrpc: '2.0',
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    });
    const unknown = await rpc(app, {
      id: 2,
      jsonrpc: '2.0',
      method: 'initialize',
      params: { protocolVersion: '1999-01-01' },
    });

    expect(known.statusCode).toBe(200);
    expect(known.json()).toMatchObject({
      id: 1,
      jsonrpc: '2.0',
      result: {
        capabilities: { tools: {} },
        protocolVersion: '2025-03-26',
        serverInfo: { name: 'cerebra' },
      },
    });
    expect(unknown.json().result.protocolVersion).toBe('2025-06-18');
  });

  test('accepts notifications without a response body', async () => {
    const app = await serve();

    const response = await rpc(app, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    expect(response.statusCode).toBe(202);
    expect(response.body).toBe('');
  });

  test('answers ping and lists the caller’s tools', async () => {
    const app = await serve();

    const ping = await rpc(app, { id: 'p', jsonrpc: '2.0', method: 'ping' });
    const listed = await rpc(app, {
      id: 3,
      jsonrpc: '2.0',
      method: 'tools/list',
    });

    expect(ping.json()).toEqual({ id: 'p', jsonrpc: '2.0', result: {} });
    expect(listed.json()).toMatchObject({
      id: 3,
      result: { tools: [{ name: 'get_item' }] },
    });
  });

  test('calls a tool as the token’s run and returns its value as text', async () => {
    const app = await serve();

    const response = await rpc(app, {
      id: 4,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { to: 'build_ready' }, name: 'transition' },
    });

    expect(calls).toEqual([
      {
        args: { to: 'build_ready' },
        caller: { runId: 'run-1' },
        name: 'transition',
      },
    ]);
    expect(response.json()).toEqual({
      id: 4,
      jsonrpc: '2.0',
      result: {
        content: [
          {
            text: JSON.stringify({ id: 'item-1', state: 'build_ready' }),
            type: 'text',
          },
        ],
        isError: false,
      },
    });
  });

  test('returns a refusal as a tool error the agent can read', async () => {
    const app = await serve(async () => ({
      code: 'tool_not_allowed',
      message: 'A assistant run may not call transition.',
      ok: false,
    }));

    const response = await rpc(app, {
      id: 5,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'transition' },
    });

    expect(calls[0]?.args).toEqual({});
    expect(response.json().result).toEqual({
      content: [
        {
          text: JSON.stringify({
            error: 'tool_not_allowed',
            message: 'A assistant run may not call transition.',
          }),
          type: 'text',
        },
      ],
      isError: true,
    });
  });

  test('refuses a missing or unknown run token', async () => {
    const app = await serve();
    const body = { id: 1, jsonrpc: '2.0', method: 'ping' };

    const missing = await rpc(app, body, { authorization: '' });
    const unknown = await rpc(app, body, { authorization: 'Bearer nope' });

    expect(missing.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  test('refuses a request a browser page sent', async () => {
    const app = await serve();

    const response = await rpc(
      app,
      { id: 1, jsonrpc: '2.0', method: 'ping' },
      { origin: 'http://evil.example' },
    );

    expect(response.statusCode).toBe(403);
  });

  test('offers no event stream and no session to delete', async () => {
    const app = await serve();

    for (const method of ['GET', 'DELETE'] as const) {
      const response = await app.inject({ method, url: '/mcp' });
      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe('POST');
    }
  });

  test('answers JSON-RPC errors for what it cannot serve', async () => {
    const app = await serve();

    const unknownMethod = await rpc(app, {
      id: 6,
      jsonrpc: '2.0',
      method: 'resources/list',
    });
    const batch = await rpc(app, [{ id: 7, jsonrpc: '2.0', method: 'ping' }]);
    const malformed = await rpc(app, { id: 8, method: 'ping' });
    const nameless = await rpc(app, {
      id: 9,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {},
    });

    expect(unknownMethod.json()).toMatchObject({
      error: { code: -32601 },
      id: 6,
    });
    expect(batch.statusCode).toBe(400);
    expect(batch.json()).toMatchObject({ error: { code: -32600 }, id: null });
    expect(malformed.json()).toMatchObject({ error: { code: -32600 } });
    expect(nameless.json()).toMatchObject({ error: { code: -32602 }, id: 9 });
  });

  test('hides a tool’s failure behind an internal error', async () => {
    const app = await serve(async () => {
      throw new Error('connection terminated: password=hunter2');
    });

    const response = await rpc(app, {
      id: 10,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name: 'get_item' },
    });

    expect(response.json()).toEqual({
      error: { code: -32603, message: 'Internal error' },
      id: 10,
      jsonrpc: '2.0',
    });
  });
});
