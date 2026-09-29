import type { Kysely } from 'kysely';
import { describe, expect, test } from 'vitest';

import { createBoard } from './board.js';
import type { Database } from './database.js';
import {
  createDispatcher,
  type DispatchedRun,
  type DispatcherOptions,
} from './dispatcher.js';
import type { Priority, WorkItemState } from './lifecycle.js';
import { hashRunToken } from './runner-gateway.js';
import { createStartSettings } from './start-settings.js';
import {
  agentNamed,
  registerTestProject,
  withTestDatabase,
} from './test-support.js';

function dispatcherFor(
  database: Kysely<Database>,
  overrides: Partial<DispatcherOptions> = {},
) {
  const launched: DispatchedRun[] = [];
  const dispatcher = createDispatcher({
    credentials: { problemsFor: async () => [] },
    database,
    launch: async (run) => {
      launched.push(run);
    },
    ...overrides,
  });
  return { dispatcher, launched };
}

async function fileItem(
  database: Kysely<Database>,
  projectId: string,
  title: string,
  {
    priority = 'P2',
    state = 'build_ready',
    minutesAgo = 0,
  }: {
    priority?: Priority;
    state?: WorkItemState;
    minutesAgo?: number;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await createBoard(database).createWorkItem({
    description: `About ${title}.`,
    id,
    priority,
    projectId,
    state,
    title,
  });
  await database
    .updateTable('work_items')
    .set({ updated_at: new Date(Date.now() - minutesAgo * 60_000) })
    .where('id', '=', id)
    .execute();
  return id;
}

async function itemState(database: Kysely<Database>, id: string) {
  return database
    .selectFrom('work_items')
    .select(['state', 'holder_run_id'])
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

async function log(database: Kysely<Database>) {
  return database
    .selectFrom('dispatch_log')
    .select(['decision', 'reason', 'work_item_id', 'agent_id', 'run_id'])
    .orderBy('id')
    .execute();
}

describe('the dispatcher', () => {
  test('claims an item and inserts its run together, then hands the run over to start', async () => {
    await withTestDatabase(async (database) => {
      const projectId = await registerTestProject(database);
      const itemId = await fileItem(database, projectId, 'Fix export');
      const { dispatcher, launched } = dispatcherFor(database);

      await dispatcher.dispatch();

      const item = await itemState(database, itemId);
      expect(item.state).toBe('building');
      const run = await database
        .selectFrom('runs')
        .select([
          'id',
          'agent_id',
          'agent_name',
          'project_id',
          'role',
          'status',
          'token_hash',
        ])
        .executeTakeFirstOrThrow();
      expect(run).toMatchObject({
        agent_id: await agentNamed(database, projectId, 'Cyclops'),
        agent_name: 'Cyclops',
        id: item.holder_run_id,
        project_id: projectId,
        role: 'builder',
        status: 'starting',
      });
      expect(launched).toEqual([
        {
          agentId: run.agent_id,
          firstMessage: 'Fix export\n\nAbout Fix export.',
          runId: run.id,
          token: expect.any(String),
        },
      ]);
      expect(hashRunToken(launched[0].token)).toBe(run.token_hash);
      expect(await log(database)).toEqual([
        {
          agent_id: run.agent_id,
          decision: 'started',
          reason: 'Cyclops started on the item.',
          run_id: run.id,
          work_item_id: itemId,
        },
      ]);
    });
  });

  test('starts nothing in a paused project, and logs the refusal once', async () => {
    await withTestDatabase(async (database) => {
      const projectId = await registerTestProject(database);
      const itemId = await fileItem(database, projectId, 'Fix export');
      await createStartSettings(database).setPaused(projectId, true);
      const { dispatcher, launched } = dispatcherFor(database);

      await dispatcher.dispatch();
      await dispatcher.dispatch();

      expect((await itemState(database, itemId)).state).toBe('build_ready');
      expect(launched).toEqual([]);
      expect(await log(database)).toEqual([
        {
          agent_id: null,
          decision: 'refused',
          reason: 'automatic starts are paused',
          run_id: null,
          work_item_id: itemId,
        },
      ]);
      expect(await dispatcher.status(projectId)).toEqual({
        limit: 1,
        paused: true,
        running: 0,
        waiting: [{ itemId, reason: { kind: 'paused' } }],
      });
    });
  });

  test('holds work back at the project limit and says why', async () => {
    await withTestDatabase(async (database) => {
      const projectId = await registerTestProject(database);
      const first = await fileItem(database, projectId, 'Urgent', {
        priority: 'P0',
      });
      const second = await fileItem(database, projectId, 'Later', {
        minutesAgo: 5,
      });
      const { dispatcher, launched } = dispatcherFor(database);

      await dispatcher.dispatch();

      expect(launched).toHaveLength(1);
      expect((await itemState(database, first)).state).toBe('building');
      expect(await dispatcher.status(projectId)).toEqual({
        limit: 1,
        paused: false,
        running: 1,
        waiting: [
          {
            itemId: second,
            reason: { kind: 'project_limit', limit: 1, running: 1 },
          },
        ],
      });
    });
  });

  test('never claims one item twice or passes a limit when dispatches overlap', async () => {
    await withTestDatabase(async (database) => {
      const projectId = await registerTestProject(database);
      await createStartSettings(database).setProjectLimit(projectId, 2);
      for (const title of ['One', 'Two', 'Three']) {
        await fileItem(database, projectId, title);
      }
      const one = dispatcherFor(database);
      const two = dispatcherFor(database);

      await Promise.all([one.dispatcher.dispatch(), two.dispatcher.dispatch()]);

      const runs = await database
        .selectFrom('runs')
        .select(['id', 'agent_id'])
        .execute();
      expect(runs).toHaveLength(2);
      expect(new Set(runs.map((run) => run.agent_id)).size).toBe(2);
      const held = await database
        .selectFrom('work_items')
        .select('holder_run_id')
        .where('state', '=', 'building')
        .execute();
      expect(held.map((row) => row.holder_run_id).sort()).toEqual(
        runs.map((run) => run.id).sort(),
      );
      expect(one.launched.length + two.launched.length).toBe(2);
    });
  });

  test('leaves a type set to manual start, and turned-off agents, alone', async () => {
    await withTestDatabase(async (database) => {
      const projectId = await registerTestProject(database);
      await createStartSettings(database).setProjectLimit(projectId, 3);
      const build = await fileItem(database, projectId, 'Build it');
      const design = await fileItem(database, projectId, 'Draw it', {
        state: 'design_ready',
      });
      const producer = await database
        .selectFrom('agent_types')
        .select('id')
        .where('name', '=', 'producer')
        .executeTakeFirstOrThrow();
      await database
        .insertInto('agent_type_overrides')
        .values({
          agent_type_id: producer.id,
          fields: JSON.stringify({
            triggers: [{ kind: 'navigator' }],
          }) as never,
          project_id: projectId,
        })
        .execute();
      await database
        .updateTable('agents')
        .set({ enabled: false })
        .where('name', '=', 'Xavier')
        .execute();
      const { dispatcher, launched } = dispatcherFor(database);

      await dispatcher.dispatch();

      expect(launched).toEqual([]);
      expect((await itemState(database, build)).state).toBe('build_ready');
      expect((await dispatcher.status(projectId)).waiting).toEqual([
        {
          itemId: design,
          reason: { kind: 'no_free_agent', role: 'designer' },
        },
      ]);
    });
  });

  test('does not start a type whose credential is missing, and names the service', async () => {
    await withTestDatabase(async (database) => {
      const projectId = await registerTestProject(database);
      const itemId = await fileItem(database, projectId, 'Fix export');
      const { dispatcher, launched } = dispatcherFor(database, {
        credentials: {
          problemsFor: async ({ agentType }) =>
            agentType === 'producer' ? ['GitHub access token'] : [],
        },
      });

      await dispatcher.dispatch();

      expect(launched).toEqual([]);
      expect((await dispatcher.status(projectId)).waiting).toEqual([
        {
          itemId,
          reason: { kind: 'credential_missing', service: 'GitHub' },
        },
      ]);
      expect((await log(database))[0]).toMatchObject({
        decision: 'refused',
        reason: 'GitHub credential missing',
      });
    });
  });

  test('keeps the Cerebra-wide limit across projects', async () => {
    await withTestDatabase(async (database) => {
      const settings = createStartSettings(database);
      await settings.setInstanceLimit(1);
      const first = await registerTestProject(database, 'website');
      const second = await registerTestProject(database, 'docs');
      await fileItem(database, first, 'Newer', { minutesAgo: 1 });
      const older = await fileItem(database, second, 'Older', {
        minutesAgo: 9,
      });
      const { dispatcher, launched } = dispatcherFor(database);

      await dispatcher.dispatch();

      expect(launched).toHaveLength(1);
      expect((await itemState(database, older)).state).toBe('building');
      expect((await dispatcher.status(first)).waiting).toEqual([
        {
          itemId: expect.any(String),
          reason: { kind: 'instance_limit', limit: 1, running: 1 },
        },
      ]);
    });
  });

  test('coalesces nudges into dispatches that finish', async () => {
    await withTestDatabase(async (database) => {
      const projectId = await registerTestProject(database);
      await fileItem(database, projectId, 'Fix export');
      const { dispatcher, launched } = dispatcherFor(database);

      dispatcher.nudge();
      dispatcher.nudge();
      dispatcher.nudge();
      await dispatcher.idle();

      expect(launched).toHaveLength(1);
    });
  });

  test('answers an unknown project as not found', async () => {
    await withTestDatabase(async (database) => {
      const { dispatcher } = dispatcherFor(database);

      await expect(
        dispatcher.status(crypto.randomUUID()),
      ).rejects.toMatchObject({ name: 'ProjectNotFoundError' });
    });
  });
});
