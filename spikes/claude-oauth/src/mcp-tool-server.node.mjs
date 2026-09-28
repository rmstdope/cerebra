import assert from 'node:assert/strict';
import test from 'node:test';

import { MCP_TOOL_RESULT, createMcpToolServer } from './mcp-tool-server.mjs';

async function startServer(onToolCall) {
  const server = createMcpToolServer({
    bearerToken: 'valid-run-token',
    onToolCall,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function postRpc(url, authorization, body) {
  return fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: JSON.stringify(body),
  });
}

test('refuses missing and invalid bearer tokens before exposing MCP tools', async (t) => {
  const server = await startServer(() => {
    throw new Error('An unauthorized request reached the tool.');
  });
  t.after(() => server.close());

  for (const authorization of [undefined, 'Bearer invalid-run-token']) {
    const response = await postRpc(server.url, authorization, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });

    assert.equal(response.status, 401);
    assert.equal(await response.text(), '');
  }
});

test('accepts the configured bearer token and returns the external tool result', async (t) => {
  let calls = 0;
  const server = await startServer(() => {
    calls += 1;
  });
  t.after(() => server.close());

  const headers = 'Bearer valid-run-token';
  const initialized = await postRpc(server.url, headers, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    },
  });
  assert.equal(initialized.status, 200);
  assert.equal(
    (await initialized.json()).result.serverInfo.name,
    'cerebra-mcp-spike',
  );

  const negotiated = await postRpc(server.url, headers, {
    jsonrpc: '2.0',
    id: 4,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'newer-client', version: '1.0.0' },
    },
  });
  assert.equal((await negotiated.json()).result.protocolVersion, '2025-11-25');

  const tools = await postRpc(server.url, headers, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  });
  assert.deepEqual((await tools.json()).result.tools, [
    {
      name: 'read_external_result',
      description: 'Read the deterministic result from the external MCP spike.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  ]);

  const result = await postRpc(server.url, headers, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'read_external_result', arguments: {} },
  });
  assert.deepEqual((await result.json()).result, {
    content: [{ type: 'text', text: MCP_TOOL_RESULT }],
  });
  assert.equal(calls, 1);
});
