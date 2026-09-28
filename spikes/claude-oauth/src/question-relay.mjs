import http from 'node:http';

export const spikeAnswer = 'Continue the OAuth-only rootless Podman spike.';

export function createQuestionRelay(onQuestion = () => {}) {
  return http.createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/question') {
      response.writeHead(404).end();
      return;
    }

    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    let questions;
    try {
      ({ questions } = JSON.parse(Buffer.concat(chunks).toString()));
    } catch {
      response.writeHead(400).end();
      return;
    }

    if (!Array.isArray(questions)) {
      response.writeHead(400).end();
      return;
    }

    onQuestion(questions);
    process.stdout.write('RELAY_RECEIVED_QUESTION\n');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ answer: spikeAnswer }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number.parseInt(process.env.QUESTION_RELAY_PORT ?? '8080', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('QUESTION_RELAY_PORT must be a valid port number.');
  }

  createQuestionRelay().listen(port, '0.0.0.0');
}
