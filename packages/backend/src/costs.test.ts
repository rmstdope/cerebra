import type { Kysely } from 'kysely';
import { describe, expect, test } from 'vitest';

import { ProjectNotFoundError, WorkItemNotFoundError } from './board.js';
import { createCostReader } from './costs.js';
import type { Database } from './database.js';
import { registerTestProject, withTestDatabase } from './test-support.js';

async function addItem(
  database: Kysely<Database>,
  projectId: string,
  title: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await database
    .insertInto('work_items')
    .values({
      attempts: 0,
      description: '',
      id,
      priority: 'P1',
      project_id: projectId,
      rounds: 0,
      state: 'build_ready',
      title,
    })
    .execute();
  return id;
}

async function addRun(
  database: Kysely<Database>,
  run: {
    agentName: string;
    costUsd: number;
    itemId: string | null;
    projectId: string;
    role: 'assistant' | 'builder' | 'designer';
    startedAt: string;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await database
    .insertInto('runs')
    .values({
      agent_name: run.agentName,
      cost_usd: run.costUsd,
      created_at: new Date(run.startedAt),
      id,
      project_id: run.projectId,
      role: run.role,
      status: 'finished',
      work_item_id: run.itemId,
    })
    .execute();
  return id;
}

describe('the cost reader', { concurrent: false }, () => {
  test("an item's cost is the sum of the runs that worked on it, newest first", async () => {
    await withTestDatabase(async (database) => {
      const projectId = await registerTestProject(database);
      const itemId = await addItem(database, projectId, 'Share reports');
      const other = await addItem(database, projectId, 'Export data');
      const first = await addRun(database, {
        agentName: 'Storm',
        costUsd: 1.25,
        itemId,
        projectId,
        role: 'designer',
        startedAt: '2026-10-01T09:00:00Z',
      });
      const second = await addRun(database, {
        agentName: 'Rogue',
        costUsd: 2.5,
        itemId,
        projectId,
        role: 'builder',
        startedAt: '2026-10-01T10:00:00Z',
      });
      await addRun(database, {
        agentName: 'Rogue',
        costUsd: 9,
        itemId: other,
        projectId,
        role: 'builder',
        startedAt: '2026-10-01T11:00:00Z',
      });

      const cost = await createCostReader(database).forItem(itemId);

      expect(cost.totalUsd).toBeCloseTo(3.75);
      expect(cost.runs).toEqual([
        {
          agentName: 'Rogue',
          costUsd: 2.5,
          id: second,
          role: 'builder',
          startedAt: new Date('2026-10-01T10:00:00Z'),
          state: 'finished',
        },
        {
          agentName: 'Storm',
          costUsd: 1.25,
          id: first,
          role: 'designer',
          startedAt: new Date('2026-10-01T09:00:00Z'),
          state: 'finished',
        },
      ]);
      expect(await createCostReader(database).forItem(other)).toMatchObject({
        totalUsd: 9,
      });
    });
  });

  test('an item nothing has worked on costs nothing', async () => {
    await withTestDatabase(async (database) => {
      const projectId = await registerTestProject(database);
      const itemId = await addItem(database, projectId, 'Share reports');

      expect(await createCostReader(database).forItem(itemId)).toEqual({
        runs: [],
        totalUsd: 0,
      });
    });
  });

  test("a project's cost splits work items from runs not linked to work", async () => {
    await withTestDatabase(async (database) => {
      const projectId = await registerTestProject(database);
      const elsewhere = await registerTestProject(database, 'elsewhere');
      const itemId = await addItem(database, projectId, 'Share reports');
      const linked = await addRun(database, {
        agentName: 'Rogue',
        costUsd: 2,
        itemId,
        projectId,
        role: 'builder',
        startedAt: '2026-10-01T09:00:00Z',
      });
      const chat = await addRun(database, {
        agentName: 'Cerebro',
        costUsd: 0.5,
        itemId: null,
        projectId,
        role: 'assistant',
        startedAt: '2026-10-01T10:00:00Z',
      });
      await addRun(database, {
        agentName: 'Rogue',
        costUsd: 7,
        itemId: null,
        projectId: elsewhere,
        role: 'builder',
        startedAt: '2026-10-01T11:00:00Z',
      });

      const cost = await createCostReader(database).forProject(projectId);

      expect(cost).toMatchObject({
        notLinkedUsd: 0.5,
        totalUsd: 2.5,
        workItemsUsd: 2,
      });
      expect(cost.runs).toEqual([
        expect.objectContaining({ id: chat, item: null }),
        expect.objectContaining({
          id: linked,
          item: { id: itemId, title: 'Share reports' },
        }),
      ]);
      expect(
        await createCostReader(database).forProject(elsewhere),
      ).toMatchObject({ notLinkedUsd: 7, totalUsd: 7, workItemsUsd: 0 });
    });
  });

  test('unknown items and projects are refused rather than costing nothing', async () => {
    await withTestDatabase(async (database) => {
      const costs = createCostReader(database);

      await expect(costs.forItem(crypto.randomUUID())).rejects.toBeInstanceOf(
        WorkItemNotFoundError,
      );
      await expect(costs.forItem('not-a-uuid')).rejects.toBeInstanceOf(
        WorkItemNotFoundError,
      );
      await expect(
        costs.forProject(crypto.randomUUID()),
      ).rejects.toBeInstanceOf(ProjectNotFoundError);
    });
  });
});
