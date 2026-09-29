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
  AgentUnavailableError,
  RunEndedError,
  RunNotFoundError,
  RunStartError,
  type ConversationControl,
  type Conversation,
  type RunUpdate,
} from '@cerebra/backend';
import { afterEach, expect, test } from 'vitest';
import { WebSocket } from 'ws';

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
  conversation: null,
  startFailed: false,
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
      return { runId: 'run-1' };
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
  expect(start.json()).toEqual({ runId: 'run-1' });
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

test('a start that fails or is refused answers 409 with its reason', async () => {
  const server = await serve(fakeFleet(), {
    start: async (agentId) => {
      if (agentId === 'busy') {
        throw new AgentUnavailableError(
          'already_running',
          'Astra is already running.',
        );
      }
      throw new RunStartError('run-9', 'Astra couldn’t start.');
    },
    stop: async () => {},
  });

  const failed = await server.inject({
    method: 'POST',
    url: '/api/agents/agent-1/start',
  });
  const busy = await server.inject({
    method: 'POST',
    url: '/api/agents/busy/start',
  });

  expect(failed.statusCode).toBe(409);
  expect(failed.json()).toEqual({
    code: 'start_failed',
    error: 'Astra couldn’t start.',
    runId: 'run-9',
  });
  expect(busy.statusCode).toBe(409);
  expect(busy.json()).toMatchObject({ code: 'already_running' });
});

const conversation: Conversation = {
  events: [
    {
      createdAt: new Date('2026-10-01T10:14:00Z'),
      event: { kind: 'user_message', text: 'Hello' },
      position: 1,
    },
    {
      createdAt: new Date('2026-10-01T10:14:05Z'),
      event: { kind: 'message', text: 'Hi' },
      position: 2,
    },
  ],
  run: {
    agentId: 'agent-1',
    agentName: 'Astra',
    agentRole: 'assistant',
    containerId: 'container-1',
    endedAt: null,
    failure: null,
    id: 'run-1',
    item: null,
    projectId: 'project-1',
    role: 'assistant',
    startFailed: false,
    startedAt: new Date('2026-10-01T10:14:00Z'),
    state: 'active',
  },
};

function fakeConversations(
  calls: string[],
  listeners: Array<(update: RunUpdate) => void> = [],
): ConversationControl {
  const known = (runId: string) => {
    if (runId === 'ended') throw new RunEndedError();
    if (runId !== 'run-1') throw new RunNotFoundError(runId);
  };
  return {
    answer: async (runId, questionId, answers) => {
      known(runId);
      calls.push(`answer ${questionId} ${JSON.stringify(answers)}`);
    },
    read: async (runId) => (runId === 'run-1' ? conversation : null),
    send: async (runId, text) => {
      known(runId);
      calls.push(`send ${text}`);
    },
    stopRun: async (runId) => {
      known(runId);
      calls.push('stop');
    },
    subscribe: (_runId, listener) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
  };
}

async function serveConversations(control: ConversationControl) {
  const server = await createServer({ auth, conversations: control });
  servers.push(server);
  return server;
}

test('reads a conversation, and answers 404 for one that does not exist', async () => {
  const server = await serveConversations(fakeConversations([]));

  const found = await server.inject('/api/runs/run-1');
  const missing = await server.inject('/api/runs/other');

  expect(found.statusCode).toBe(200);
  expect(found.json()).toEqual({
    events: [
      {
        createdAt: '2026-10-01T10:14:00.000Z',
        event: { kind: 'user_message', text: 'Hello' },
        position: 1,
        type: 'event',
      },
      {
        createdAt: '2026-10-01T10:14:05.000Z',
        event: { kind: 'message', text: 'Hi' },
        position: 2,
        type: 'event',
      },
    ],
    run: {
      agentId: 'agent-1',
      agentName: 'Astra',
      agentRole: 'assistant',
      endedAt: null,
      failure: null,
      id: 'run-1',
      item: null,
      startedAt: '2026-10-01T10:14:00.000Z',
      state: 'active',
    },
  });
  expect(missing.statusCode).toBe(404);
  expect(missing.json()).toEqual({ error: 'Conversation not found.' });
});

test('messages, answers and stop reach the run, checked first', async () => {
  const calls: string[] = [];
  const server = await serveConversations(fakeConversations(calls));
  const post = (url: string, payload?: unknown) =>
    server.inject({ method: 'POST', payload: payload as object, url });

  expect(
    (await post('/api/runs/run-1/messages', { text: 'Hi' })).statusCode,
  ).toBe(202);
  expect(
    (await post('/api/runs/run-1/messages', { text: '  ' })).json(),
  ).toEqual({
    error: 'Write a message.',
  });
  expect(
    (
      await post('/api/runs/run-1/answers', {
        answers: { Which: 'This one' },
        questionId: 'q-1',
      })
    ).statusCode,
  ).toBe(202);
  expect(
    (await post('/api/runs/run-1/answers', { answers: {}, questionId: 'q-1' }))
      .statusCode,
  ).toBe(400);
  expect((await post('/api/runs/run-1/stop')).statusCode).toBe(202);
  const ended = await post('/api/runs/ended/messages', { text: 'Hi' });
  expect(ended.statusCode).toBe(409);
  expect(ended.json()).toEqual({
    code: 'run_ended',
    error: 'This conversation has ended.',
  });
  expect((await post('/api/runs/other/stop')).statusCode).toBe(404);
  expect(calls).toEqual(['send Hi', 'answer q-1 {"Which":"This one"}', 'stop']);
});

test('the conversation socket replays events after a position, then streams live ones', async () => {
  const listeners: Array<(update: RunUpdate) => void> = [];
  const server = await serveConversations(fakeConversations([], listeners));
  await server.ready();
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  const received: unknown[] = [];
  const socket = new WebSocket(
    `${address.replace('http', 'ws')}/ws/runs/run-1?after=1`,
  );
  socket.on('message', (value) => received.push(JSON.parse(value.toString())));
  const arrived = async (count: number) => {
    while (received.length < count) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  await arrived(2);
  listeners[0]?.({
    createdAt: new Date('2026-10-01T10:15:00Z'),
    event: { kind: 'message', text: 'More' },
    position: 3,
    type: 'event',
  });
  listeners[0]?.({ failure: null, state: 'finished', type: 'state' });
  await arrived(4);
  socket.close();

  expect(received).toEqual([
    {
      createdAt: '2026-10-01T10:14:05.000Z',
      event: { kind: 'message', text: 'Hi' },
      position: 2,
      type: 'event',
    },
    { failure: null, state: 'active', type: 'state' },
    {
      createdAt: '2026-10-01T10:15:00.000Z',
      event: { kind: 'message', text: 'More' },
      position: 3,
      type: 'event',
    },
    { failure: null, state: 'finished', type: 'state' },
  ]);
});

test('the conversation socket and routes require a signed-in navigator', async () => {
  const server = await createServer({
    auth: {
      ...auth,
      status: async () => ({
        reason: 'signed-out' as const,
        state: 'unauthenticated' as const,
      }),
    },
    conversations: fakeConversations([]),
  });
  servers.push(server);
  await server.ready();

  expect((await server.inject('/api/runs/run-1')).statusCode).toBe(401);
  await expect(server.injectWS('/ws/runs/run-1')).rejects.toThrow();
});
