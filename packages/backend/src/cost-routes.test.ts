import {
  createServer,
  ProjectNotFoundError,
  WorkItemNotFoundError,
  type CostReader,
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

const run = {
  agentName: 'Rogue',
  costUsd: 2,
  id: 'run-1',
  role: 'builder' as const,
  startedAt: new Date('2026-10-01T09:00:00Z'),
  state: 'finished' as const,
};

const costs: CostReader = {
  forItem: async (itemId) => {
    if (itemId !== 'item-1') throw new WorkItemNotFoundError(itemId);
    return { runs: [run], totalUsd: 2 };
  },
  forProject: async (projectId) => {
    if (projectId !== 'project-1') throw new ProjectNotFoundError(projectId);
    return {
      notLinkedUsd: 0,
      runs: [{ ...run, item: { id: 'item-1', title: 'Share reports' } }],
      totalUsd: 2,
      workItemsUsd: 2,
    };
  },
};

test('a work item and a project answer what they have cost so far', async () => {
  const server = await createServer({ auth, costs });
  servers.push(server);

  const item = await server.inject('/api/work-items/item-1/cost');
  expect(item.statusCode).toBe(200);
  expect(item.json()).toEqual({
    runs: [{ ...run, startedAt: '2026-10-01T09:00:00.000Z' }],
    totalUsd: 2,
  });

  const project = await server.inject('/api/projects/project-1/cost');
  expect(project.statusCode).toBe(200);
  expect(project.json()).toMatchObject({
    notLinkedUsd: 0,
    totalUsd: 2,
    workItemsUsd: 2,
  });
});

test('an unknown item or project is a 404, and no cost reader is a 503', async () => {
  const server = await createServer({ auth, costs });
  servers.push(server);

  expect((await server.inject('/api/work-items/nothing/cost')).statusCode).toBe(
    404,
  );
  expect((await server.inject('/api/projects/nothing/cost')).statusCode).toBe(
    404,
  );

  const without = await createServer({ auth });
  servers.push(without);
  expect((await without.inject('/api/work-items/item-1/cost')).statusCode).toBe(
    503,
  );
});
