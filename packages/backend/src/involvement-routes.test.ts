import {
  createServer,
  InvolvementInputError,
  ProjectNotFoundError,
  type InvolvementSetting,
  type InvolvementSettings,
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

function fakeInvolvement(): InvolvementSettings {
  let saved: InvolvementSetting = {
    involvement: 'autonomous',
    reviewAccount: null,
  };
  const known = (projectId: string) => {
    if (projectId !== 'project-1') throw new ProjectNotFoundError(projectId);
  };
  return {
    get: async (projectId) => {
      known(projectId);
      return saved;
    },
    set: async (projectId, input) => {
      known(projectId);
      const { involvement, reviewAccount } = input as InvolvementSetting;
      if (involvement === 'full' && !reviewAccount) {
        throw new InvolvementInputError(
          'Enter the GitHub account whose review counts.',
        );
      }
      saved = { involvement, reviewAccount };
      return saved;
    },
  };
}

async function serve(
  options: Partial<Parameters<typeof createServer>[0]> = {},
) {
  const server = await createServer({ auth, ...options });
  servers.push(server);
  return server;
}

test('reads and saves how closely the navigator follows a project', async () => {
  let mutations = 0;
  const server = await serve({
    involvement: fakeInvolvement(),
    onMutation: () => {
      mutations += 1;
    },
  });

  const before = await server.inject('/api/projects/project-1/involvement');
  const saved = await server.inject({
    method: 'PUT',
    payload: { involvement: 'full', reviewAccount: 'navigator' },
    url: '/api/projects/project-1/involvement',
  });
  const after = await server.inject('/api/projects/project-1/involvement');

  expect(before.json()).toEqual({
    involvement: 'autonomous',
    reviewAccount: null,
  });
  expect(saved.statusCode).toBe(200);
  expect(after.json()).toEqual({
    involvement: 'full',
    reviewAccount: 'navigator',
  });
  expect(mutations).toBe(1);
});

test('refuses a setting with the words the form shows, and an unknown project', async () => {
  const server = await serve({ involvement: fakeInvolvement() });

  const refused = await server.inject({
    method: 'PUT',
    payload: { involvement: 'full', reviewAccount: '' },
    url: '/api/projects/project-1/involvement',
  });
  const missing = await server.inject('/api/projects/other/involvement');

  expect(refused.statusCode).toBe(400);
  expect(refused.json()).toEqual({
    code: 'invalid_involvement',
    error: 'Enter the GitHub account whose review counts.',
  });
  expect(missing.statusCode).toBe(404);
});

test('answers 503 rather than a default when the setting cannot be read', async () => {
  const server = await serve();

  const response = await server.inject('/api/projects/project-1/involvement');

  expect(response.statusCode).toBe(503);
});
