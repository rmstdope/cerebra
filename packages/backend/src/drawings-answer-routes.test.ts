import {
  createServer,
  DrawingsAnswerError,
  type DrawingQuestions,
} from '@cerebra/backend';
import { afterEach, expect, test } from 'vitest';

const servers: Array<{ close: () => Promise<void> }> = [];
const auth = {
  setup: async () => ({
    ok: false as const,
    reason: 'already-configured' as const,
  }),
  signIn: async () => ({
    ok: false as const,
    reason: 'rejected-password' as const,
  }),
  signOut: async () => undefined,
  status: async () => ({ state: 'authenticated' as const }),
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function serve(
  options: Partial<Parameters<typeof createServer>[0]> = {},
) {
  const server = await createServer({ auth, ...options });
  servers.push(server);
  return server;
}

const runId = '11111111-1111-4111-8111-111111111111';
const drawingsId = '33333333-3333-4333-8333-333333333333';

test('answers a drawings round', async () => {
  const answers: unknown[] = [];
  const drawings: Pick<DrawingQuestions, 'answer'> = {
    answer: async (run, input) => {
      answers.push([run, input]);
      return { choice: 'A · Button in the toolbar', text: '' };
    },
  };
  const server = await serve({ drawings });

  const response = await server.inject({
    method: 'POST',
    payload: { choice: 'A · Button in the toolbar', drawingsId },
    url: `/api/runs/${runId}/drawings-answers`,
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    choice: 'A · Button in the toolbar',
    text: '',
  });
  expect(answers).toEqual([
    [runId, { choice: 'A · Button in the toolbar', drawingsId }],
  ]);
});

test.each([
  ['invalid', 400, 'invalid_answer'],
  ['not_waiting', 409, 'not_waiting'],
] as const)(
  'refuses an answer to a round that is %s with %i',
  async (code, status, body) => {
    const server = await serve({
      drawings: {
        answer: async () => {
          throw new DrawingsAnswerError(code, 'Refused.');
        },
      },
    });

    const response = await server.inject({
      method: 'POST',
      payload: {},
      url: `/api/runs/${runId}/drawings-answers`,
    });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ code: body, error: 'Refused.' });
  },
);

test('answers 503 when no round can wait', async () => {
  const server = await serve();

  const response = await server.inject({
    method: 'POST',
    payload: {},
    url: `/api/runs/${runId}/drawings-answers`,
  });

  expect(response.statusCode).toBe(503);
});
