import {
  createServer,
  LimitInputError,
  ProjectNotFoundError,
  type AutomaticStartStatus,
  type StartSettings,
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

const pausedProjects = new Map<string, boolean>();

function fakeSettings(): StartSettings {
  pausedProjects.clear();
  let instanceLimit = 3;
  let projectLimit = 2;
  const known = (projectId: string) => {
    if (projectId !== 'project-1') {
      throw new ProjectNotFoundError(projectId);
    }
  };
  return {
    paused: async (projectId: string) => pausedProjects.get(projectId) ?? false,
    limits: async (projectId?: string) => {
      if (projectId !== undefined) known(projectId);
      return {
        instanceLimit,
        projectLimit: projectId === undefined ? null : projectLimit,
      };
    },
    setProjectLimit: async (projectId: string, value: unknown) => {
      known(projectId);
      if (typeof value !== 'number' || value < 1) {
        throw new LimitInputError('Enter a whole number of 1 or more.');
      }
      projectLimit = value;
      return { instanceLimit, projectLimit };
    },
    setInstanceLimit: async (value: unknown) => {
      if (typeof value !== 'number' || value < 1) {
        throw new LimitInputError('Enter a whole number of 1 or more.');
      }
      instanceLimit = value;
      return { instanceLimit, projectLimit: null };
    },
    setPaused: async (projectId: string, paused: boolean) => {
      known(projectId);
      pausedProjects.set(projectId, paused);
    },
  };
}

const status: AutomaticStartStatus = {
  limit: 2,
  paused: false,
  running: 1,
  waiting: [
    {
      itemId: 'item-1',
      reason: { kind: 'credential_missing', service: 'GitHub' },
    },
    {
      itemId: 'item-2',
      reason: { kind: 'project_limit', limit: 2, running: 2 },
    },
  ],
};

async function serve(
  options: Partial<Parameters<typeof createServer>[0]> = {},
) {
  const server = await createServer({ auth, ...options });
  servers.push(server);
  return server;
}

test('reports what is running and why work waits', async () => {
  const server = await serve({
    dispatcher: {
      status: async (projectId) => {
        if (projectId !== 'project-1') {
          throw new ProjectNotFoundError(projectId);
        }
        return status;
      },
    },
  });

  const found = await server.inject('/api/projects/project-1/automatic-starts');
  const missing = await server.inject('/api/projects/other/automatic-starts');

  expect(found.statusCode).toBe(200);
  expect(found.json()).toEqual(status);
  expect(missing.statusCode).toBe(404);
});

test('answers 503 rather than an empty status when nothing can dispatch', async () => {
  const server = await serve();

  const response = await server.inject(
    '/api/projects/project-1/automatic-starts',
  );

  expect(response.statusCode).toBe(503);
});

test('pauses and resumes a project', async () => {
  const server = await serve({ startSettings: fakeSettings() });

  const paused = await server.inject({
    method: 'PUT',
    payload: { paused: true },
    url: '/api/projects/project-1/automatic-starts',
  });
  const refused = await server.inject({
    method: 'PUT',
    payload: { paused: 'yes' },
    url: '/api/projects/project-1/automatic-starts',
  });
  const missing = await server.inject({
    method: 'PUT',
    payload: { paused: true },
    url: '/api/projects/other/automatic-starts',
  });

  expect(paused.statusCode).toBe(200);
  expect(paused.json()).toEqual({ paused: true });
  expect(pausedProjects.get('project-1')).toBe(true);
  expect(refused.statusCode).toBe(400);
  expect(missing.statusCode).toBe(404);
});

test('reads and saves the project and Cerebra-wide limits', async () => {
  const server = await serve({ startSettings: fakeSettings() });

  const project = await server.inject('/api/projects/project-1/limits');
  const savedProject = await server.inject({
    method: 'PUT',
    payload: { projectLimit: 1 },
    url: '/api/projects/project-1/limits',
  });
  const savedInstance = await server.inject({
    method: 'PUT',
    payload: { instanceLimit: 5 },
    url: '/api/settings/limits',
  });
  const instance = await server.inject('/api/settings/limits');

  expect(project.json()).toEqual({ instanceLimit: 3, projectLimit: 2 });
  expect(savedProject.json()).toEqual({ instanceLimit: 3, projectLimit: 1 });
  expect(savedInstance.json()).toEqual({
    instanceLimit: 5,
    projectLimit: null,
  });
  expect(instance.json()).toEqual({ instanceLimit: 5, projectLimit: null });
});

test('refuses a limit that cannot be saved with the words the form shows', async () => {
  const server = await serve({ startSettings: fakeSettings() });

  const response = await server.inject({
    method: 'PUT',
    payload: { instanceLimit: 0 },
    url: '/api/settings/limits',
  });

  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({
    code: 'invalid_limit',
    error: 'Enter a whole number of 1 or more.',
  });
});

test('tells the dispatcher after a request changed something, and only then', async () => {
  let mutations = 0;
  const server = await serve({
    onMutation: () => {
      mutations += 1;
    },
    startSettings: fakeSettings(),
  });

  await server.inject('/api/settings/limits');
  await server.inject({
    method: 'PUT',
    payload: { instanceLimit: 0 },
    url: '/api/settings/limits',
  });
  expect(mutations).toBe(0);

  await server.inject({
    method: 'PUT',
    payload: { instanceLimit: 4 },
    url: '/api/settings/limits',
  });
  expect(mutations).toBe(1);
});
