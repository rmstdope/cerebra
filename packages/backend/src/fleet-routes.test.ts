import {
  AgentHoldsWorkError,
  AgentNotFoundError,
  AgentTypeNotFoundError,
  createServer,
  DuplicateAgentNameError,
  InvalidAgentChangeError,
  InvalidAgentNameError,
  InvalidRoleSettingsError,
  ProjectNotFoundError,
  type Fleet,
  type FleetPerson,
  type FleetRole,
  type FleetView,
  type RunControl,
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

const storm: FleetPerson = {
  activity: { kind: 'available' },
  enabled: true,
  id: 'agent-1',
  name: 'Storm',
  role: 'producer',
  running: false,
  typeId: 'type-producer',
};

const producer: FleetRole = {
  interactive: false,
  model: 'opus',
  people: ['Storm'],
  role: 'producer',
  startMode: 'ready',
  typeId: 'type-producer',
};

const view: FleetView = {
  people: [storm],
  project: { id: 'project-1', name: 'website', owner: 'acme' },
  roles: [producer],
};

function fakeFleet(overrides: Partial<Fleet> = {}): Fleet {
  const unused = async () => {
    throw new Error('Not exercised');
  };
  return {
    addAgent: unused,
    createMissingFleets: unused,
    read: unused,
    removeAgent: unused,
    saveRoleSettings: unused,
    seedAgentTypes: unused,
    updateAgent: unused,
    ...overrides,
  };
}

async function serve(fleet?: Fleet, runs?: RunControl) {
  const server = await createServer({ auth, fleet, runs });
  servers.push(server);
  return server;
}

test('reads a project fleet and refuses an unknown project', async () => {
  const server = await serve(
    fakeFleet({
      read: async (projectId) => {
        if (projectId !== 'project-1') {
          throw new ProjectNotFoundError(projectId);
        }
        return view;
      },
    }),
  );

  const found = await server.inject('/api/projects/project-1/fleet');
  const missing = await server.inject('/api/projects/other/fleet');

  expect(found.statusCode).toBe(200);
  expect(found.json()).toEqual(view);
  expect(missing.statusCode).toBe(404);
});

test('a fleet that is not configured is an explicit error, not an empty fleet', async () => {
  const server = await serve();

  const response = await server.inject('/api/projects/project-1/fleet');

  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ error: 'The fleet is unavailable.' });
});

test('adds a person and maps each refusal', async () => {
  const added: unknown[] = [];
  const server = await serve(
    fakeFleet({
      addAgent: async (projectId, input) => {
        added.push({ input, projectId });
        if (input.name === 'Storm') {
          throw new DuplicateAgentNameError('Storm');
        }
        if (input.name === '') {
          throw new InvalidAgentNameError();
        }
        if (input.typeId === 'nope') {
          throw new AgentTypeNotFoundError('nope');
        }
        return { ...storm, id: 'agent-2', name: String(input.name) };
      },
    }),
  );
  const add = (payload: unknown) =>
    server.inject({
      method: 'POST',
      payload: payload as Record<string, unknown>,
      url: '/api/projects/project-1/agents',
    });

  const ok = await add({ name: 'Rogue', typeId: 'type-producer' });
  const duplicate = await add({ name: 'Storm', typeId: 'type-producer' });
  const empty = await add({ name: '', typeId: 'type-producer' });
  const unknownType = await add({ name: 'Anna', typeId: 'nope' });
  const malformed = await add({ name: 'Anna' });

  expect(ok.statusCode).toBe(201);
  expect(ok.json()).toMatchObject({ id: 'agent-2', name: 'Rogue' });
  expect(duplicate.statusCode).toBe(409);
  expect(duplicate.json()).toEqual({
    code: 'duplicate_name',
    error: 'Another person in this fleet is already called Storm.',
  });
  expect(empty.statusCode).toBe(400);
  expect(empty.json()).toEqual({ error: 'Enter a name.' });
  expect(unknownType.statusCode).toBe(404);
  expect(malformed.statusCode).toBe(400);
  expect(added).toHaveLength(4);
});

test('renames, disables and removes a person', async () => {
  const updates: unknown[] = [];
  const server = await serve(
    fakeFleet({
      removeAgent: async (agentId) => {
        if (agentId === 'busy') {
          throw new AgentHoldsWorkError('Storm');
        }
        if (agentId === 'gone') {
          throw new AgentNotFoundError(agentId);
        }
      },
      updateAgent: async (agentId, changes) => {
        updates.push({ agentId, changes });
        if (changes.enabled === 'yes') {
          throw new InvalidAgentChangeError();
        }
        return { ...storm, enabled: false, name: 'Anna' };
      },
    }),
  );

  const renamed = await server.inject({
    method: 'PATCH',
    payload: { enabled: false, name: 'Anna' },
    url: '/api/agents/agent-1',
  });
  const invalid = await server.inject({
    method: 'PATCH',
    payload: { enabled: 'yes' },
    url: '/api/agents/agent-1',
  });
  const removed = await server.inject({
    method: 'DELETE',
    url: '/api/agents/agent-1',
  });
  const busy = await server.inject({
    method: 'DELETE',
    url: '/api/agents/busy',
  });
  const gone = await server.inject({
    method: 'DELETE',
    url: '/api/agents/gone',
  });

  expect(renamed.statusCode).toBe(200);
  expect(renamed.json()).toMatchObject({ enabled: false, name: 'Anna' });
  expect(updates[0]).toEqual({
    agentId: 'agent-1',
    changes: { enabled: false, name: 'Anna' },
  });
  expect(invalid.statusCode).toBe(400);
  expect(removed.statusCode).toBe(204);
  expect(busy.statusCode).toBe(409);
  expect(busy.json()).toEqual({
    code: 'holds_work',
    error: 'Stop this work before removing Storm.',
  });
  expect(gone.statusCode).toBe(404);
});

test('saves a role settings choice for one project', async () => {
  const saved: unknown[] = [];
  const server = await serve(
    fakeFleet({
      saveRoleSettings: async (projectId, typeId, settings) => {
        saved.push({ projectId, settings, typeId });
        if (settings.model === 'gpt') {
          throw new InvalidRoleSettingsError('model');
        }
        return { ...producer, model: 'sonnet', startMode: 'manual' };
      },
    }),
  );

  const ok = await server.inject({
    method: 'PUT',
    payload: { model: 'sonnet', startMode: 'manual' },
    url: '/api/projects/project-1/roles/type-producer',
  });
  const invalid = await server.inject({
    method: 'PUT',
    payload: { model: 'gpt', startMode: 'manual' },
    url: '/api/projects/project-1/roles/type-producer',
  });

  expect(ok.statusCode).toBe(200);
  expect(ok.json()).toMatchObject({ model: 'sonnet', startMode: 'manual' });
  expect(saved[0]).toEqual({
    projectId: 'project-1',
    settings: { model: 'sonnet', startMode: 'manual' },
    typeId: 'type-producer',
  });
  expect(invalid.statusCode).toBe(400);
});

test('starting or stopping a person is refused explicitly until runs are supervised', async () => {
  const server = await serve(fakeFleet());

  const start = await server.inject({
    method: 'POST',
    url: '/api/agents/agent-1/start',
  });
  const stop = await server.inject({
    method: 'POST',
    url: '/api/agents/agent-1/stop',
  });

  expect(start.statusCode).toBe(503);
  expect(start.json()).toEqual({
    error: 'Cerebra can’t run agents yet.',
  });
  expect(stop.statusCode).toBe(503);
});

test('starts and stops a person through run control', async () => {
  const calls: string[] = [];
  const server = await serve(fakeFleet(), {
    start: async (agentId) => {
      calls.push(`start ${agentId}`);
    },
    stop: async (agentId) => {
      if (agentId === 'gone') {
        throw new AgentNotFoundError(agentId);
      }
      calls.push(`stop ${agentId}`);
    },
  });

  const start = await server.inject({
    method: 'POST',
    url: '/api/agents/agent-1/start',
  });
  const stop = await server.inject({
    method: 'POST',
    url: '/api/agents/agent-1/stop',
  });
  const gone = await server.inject({
    method: 'POST',
    url: '/api/agents/gone/stop',
  });

  expect(start.statusCode).toBe(202);
  expect(stop.statusCode).toBe(202);
  expect(gone.statusCode).toBe(404);
  expect(calls).toEqual(['start agent-1', 'stop agent-1']);
});

test('the fleet requires a signed-in navigator', async () => {
  const server = await createServer({
    auth: {
      ...auth,
      status: async () => ({
        reason: 'signed-out' as const,
        state: 'unauthenticated' as const,
      }),
    },
    fleet: fakeFleet({ read: async () => view }),
  });
  servers.push(server);

  const response = await server.inject('/api/projects/project-1/fleet');

  expect(response.statusCode).toBe(401);
});
