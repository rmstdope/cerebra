import http from 'node:http';

export const MCP_TOOL_RESULT = 'EXTERNAL_MCP_RESULT';

const tool = {
  name: 'read_external_result',
  description: 'Read the deterministic result from the external MCP spike.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

export function createMcpToolServer({ bearerToken, onToolCall = () => {} }) {
  if (typeof bearerToken !== 'string' || bearerToken === '') {
    throw new Error(
      'MCP_BEARER_TOKEN must be set before starting the MCP server.',
    );
  }

  return http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }

    if (request.headers.authorization !== `Bearer ${bearerToken}`) {
      response.writeHead(401).end();
      return;
    }

    let message;
    try {
      message = await requestBody(request);
    } catch {
      json(response, 400, error(null, -32700, 'Invalid JSON-RPC request.'));
      return;
    }

    switch (message.method) {
      case 'initialize':
        json(
          response,
          200,
          result(message.id, {
            protocolVersion:
              typeof message.params?.protocolVersion === 'string'
                ? message.params.protocolVersion
                : '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'cerebra-mcp-spike', version: '0.0.0' },
          }),
        );
        return;
      case 'notifications/initialized':
        response.writeHead(202).end();
        return;
      case 'tools/list':
        json(response, 200, result(message.id, { tools: [tool] }));
        return;
      case 'tools/call':
        if (message.params?.name !== tool.name) {
          json(response, 200, error(message.id, -32602, 'Unknown tool.'));
          return;
        }
        onToolCall();
        json(
          response,
          200,
          result(message.id, {
            content: [{ type: 'text', text: MCP_TOOL_RESULT }],
          }),
        );
        return;
      default:
        json(response, 200, error(message.id, -32601, 'Method not found.'));
    }
  });
}

if (import.meta.main) {
  const server = createMcpToolServer({
    bearerToken: process.env.MCP_BEARER_TOKEN,
    onToolCall: () => process.stdout.write('MCP_TOOL_CALLED\n'),
  });
  server.listen(8080, '0.0.0.0');
}
