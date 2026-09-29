import {
  createServer,
  PlanAnswerError,
  type PlanApprovals,
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

test('passes the navigator’s answer to the waiting plan', async () => {
  const answers: unknown[] = [];
  const plans: Pick<PlanApprovals, 'answer'> = {
    answer: async (run, input) => {
      answers.push([run, input]);
      return { text: 'Also handle the empty board.', verdict: 'changes' };
    },
  };
  const server = await serve({ plans });

  const response = await server.inject({
    method: 'POST',
    payload: {
      planId: 4,
      text: 'Also handle the empty board.',
      verdict: 'changes',
    },
    url: `/api/runs/${runId}/plan-answers`,
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    text: 'Also handle the empty board.',
    verdict: 'changes',
  });
  expect(answers).toEqual([
    [
      runId,
      { planId: 4, text: 'Also handle the empty board.', verdict: 'changes' },
    ],
  ]);
});

test.each([
  ['invalid', 400, 'invalid_answer'],
  ['not_waiting', 409, 'not_waiting'],
  ['not_found', 404, 'not_found'],
] as const)('answers a %s refusal with %i', async (code, status, body) => {
  const server = await serve({
    plans: {
      answer: async () => {
        throw new PlanAnswerError(code, 'Refused.');
      },
    },
  });

  const response = await server.inject({
    method: 'POST',
    payload: {},
    url: `/api/runs/${runId}/plan-answers`,
  });

  expect(response.statusCode).toBe(status);
  expect(response.json()).toEqual({ code: body, error: 'Refused.' });
});

test('answers 503 when no plan can wait', async () => {
  const server = await serve();

  const response = await server.inject({
    method: 'POST',
    payload: {},
    url: `/api/runs/${runId}/plan-answers`,
  });

  expect(response.statusCode).toBe(503);
});
