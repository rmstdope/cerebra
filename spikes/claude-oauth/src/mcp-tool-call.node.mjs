import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MCP_TOOL_RESULT,
  createMcpToolCallOptions,
  runMcpToolCall,
} from './mcp-tool-call.mjs';

async function* successfulMessages() {
  yield {
    type: 'assistant',
    message: { content: [{ type: 'text', text: MCP_TOOL_RESULT }] },
  };
  yield { type: 'result', subtype: 'success' };
}

test('configures the external HTTP MCP server with the run bearer token', () => {
  assert.deepEqual(createMcpToolCallOptions('run-token'), {
    allowedTools: ['mcp__external__read_external_result'],
    strictMcpConfig: true,
    mcpServers: {
      external: {
        type: 'http',
        url: 'http://mcp-tool-server:8080/mcp',
        headers: { Authorization: 'Bearer run-token' },
      },
    },
  });
});

test('requires Claude to receive the external MCP tool result before succeeding', async () => {
  let receivedOptions;
  const markers = [];

  await runMcpToolCall({
    bearerToken: 'run-token',
    createQuery: ({ options }) => {
      receivedOptions = options;
      return successfulMessages();
    },
    write: (marker) => markers.push(marker),
  });

  assert.deepEqual(receivedOptions, createMcpToolCallOptions('run-token'));
  assert.deepEqual(markers, ['MCP_TOOL_RESULT_RECEIVED', 'SPIKE_COMPLETE']);
});

test('fails if Claude completes without receiving the external MCP tool result', async () => {
  await assert.rejects(
    runMcpToolCall({
      bearerToken: 'run-token',
      createQuery: () =>
        (async function* () {
          yield { type: 'result', subtype: 'success' };
        })(),
      write: () => {},
    }),
    /Claude did not receive the external MCP tool result/,
  );
});
