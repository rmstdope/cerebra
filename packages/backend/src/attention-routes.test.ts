import {
  createServer,
  ProjectNotFoundError,
  type Attention,
  type NotificationSettings,
  type Notifier,
  type PushMessage,
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

const question = {
  agentName: 'Storm',
  id: 'run:run-1:q1',
  itemId: null,
  kind: 'question' as const,
  projectId: 'project-1',
  projectName: 'acme/website',
  runId: 'run-1',
  since: new Date('2026-10-01T09:00:00Z'),
  title: 'Which release?',
};

test('lists what needs the navigator, and answers 503 when it cannot', async () => {
  const attention: Attention = { list: async () => [question] };
  const server = await createServer({ attention, auth });
  servers.push(server);

  const response = await server.inject('/api/attention');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual([
    { ...question, since: '2026-10-01T09:00:00.000Z' },
  ]);

  const failing = await createServer({
    attention: {
      list: async () => {
        throw new Error('database down');
      },
    },
    auth,
  });
  servers.push(failing);
  expect((await failing.inject('/api/attention')).statusCode).toBe(503);

  const without = await createServer({ auth });
  servers.push(without);
  expect((await without.inject('/api/attention')).statusCode).toBe(503);
});

test('reads and changes whether each project raises browser notifications', async () => {
  const changes: Array<[string, boolean]> = [];
  const notificationSettings: NotificationSettings = {
    list: async () => [
      {
        browserNotifications: true,
        projectId: 'project-1',
        projectName: 'acme/website',
      },
    ],
    mutedProjects: async () => new Set(),
    set: async (projectId, on) => {
      if (projectId !== 'project-1') throw new ProjectNotFoundError(projectId);
      changes.push([projectId, on]);
    },
  };
  const server = await createServer({ auth, notificationSettings });
  servers.push(server);

  expect((await server.inject('/api/notification-settings')).json()).toEqual([
    {
      browserNotifications: true,
      projectId: 'project-1',
      projectName: 'acme/website',
    },
  ]);

  const turnedOff = await server.inject({
    method: 'PUT',
    payload: { browserNotifications: false },
    url: '/api/projects/project-1/notification-settings',
  });
  expect(turnedOff.statusCode).toBe(200);
  expect(turnedOff.json()).toEqual({
    browserNotifications: false,
    projectId: 'project-1',
  });
  expect(changes).toEqual([['project-1', false]]);

  const bad = await server.inject({
    method: 'PUT',
    payload: { browserNotifications: 'no' },
    url: '/api/projects/project-1/notification-settings',
  });
  expect(bad.statusCode).toBe(400);
  const unknown = await server.inject({
    method: 'PUT',
    payload: { browserNotifications: true },
    url: '/api/projects/nothing/notification-settings',
  });
  expect(unknown.statusCode).toBe(404);
  expect(changes).toHaveLength(1);
});

test('the notifications socket carries pushes out and the focused chat in', async () => {
  const focuses: Array<string | null> = [];
  let push: ((message: PushMessage) => void) | undefined;
  let closed = false;
  const notifications: Pick<Notifier, 'connect'> = {
    connect: (send) => {
      push = send;
      return {
        close: () => {
          closed = true;
        },
        focus: (runId) => focuses.push(runId),
      };
    },
  };
  const server = await createServer({ auth, notifications });
  servers.push(server);
  await server.ready();
  const socket = await server.injectWS('/ws/notifications');

  const received = new Promise<unknown>((resolve) => {
    socket.once('message', (value) => resolve(JSON.parse(value.toString())));
  });
  push?.({ entries: [question], type: 'push' });
  expect(await received).toEqual({
    entries: [{ ...question, since: '2026-10-01T09:00:00.000Z' }],
    type: 'push',
  });

  socket.send(JSON.stringify({ runId: 'run-1', type: 'focus' }));
  socket.send('not json');
  socket.send(JSON.stringify({ runId: null, type: 'focus' }));
  await expect.poll(() => focuses).toEqual(['run-1', null]);

  socket.terminate();
  await expect.poll(() => closed).toBe(true);
});
