export const MCP_TOOL_RESULT = 'MCP_TOOL_RESULT_RECEIVED';

const prompt =
  'Call the read_external_result tool from the external MCP server exactly once. After receiving its result, reply with exactly MCP_TOOL_RESULT_RECEIVED. Do not use any other tool.';

function assistantText(message) {
  if (
    message.type !== 'assistant' ||
    !Array.isArray(message.message?.content)
  ) {
    return '';
  }

  return message.message.content
    .filter(
      (content) => content.type === 'text' && typeof content.text === 'string',
    )
    .map((content) => content.text)
    .join('\n');
}

export function createMcpToolCallOptions(bearerToken) {
  if (typeof bearerToken !== 'string' || bearerToken === '') {
    throw new Error('MCP_BEARER_TOKEN must be set before running this spike.');
  }

  return {
    allowedTools: ['mcp__external__read_external_result'],
    strictMcpConfig: true,
    mcpServers: {
      external: {
        type: 'http',
        url: 'http://mcp-tool-server:8080/mcp',
        headers: { Authorization: `Bearer ${bearerToken}` },
      },
    },
  };
}

export async function runMcpToolCall({ bearerToken, createQuery, write }) {
  let receivedResult = false;
  let completed = false;

  for await (const message of createQuery({
    prompt,
    options: createMcpToolCallOptions(bearerToken),
  })) {
    receivedResult ||= assistantText(message).trim() === MCP_TOOL_RESULT;
    completed ||= message.type === 'result' && message.subtype === 'success';
  }

  if (!receivedResult) {
    throw new Error('Claude did not receive the external MCP tool result.');
  }
  if (!completed) {
    throw new Error('Claude did not complete the MCP spike session.');
  }

  write(MCP_TOOL_RESULT);
  write('SPIKE_COMPLETE');
}

if (import.meta.main) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  await runMcpToolCall({
    bearerToken: process.env.MCP_BEARER_TOKEN,
    createQuery: query,
    write: (marker) => process.stdout.write(`${marker}\n`),
  });
}
