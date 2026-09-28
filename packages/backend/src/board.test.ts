import { Pool } from 'pg';
import { describe, expect, test } from 'vitest';

import { createBoard } from './board.js';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrations/index.js';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to run board tests');
}

function schemaName(): string {
  return `cerebra_board_test_${crypto.randomUUID().replaceAll('-', '')}`;
}

async function createSchema(): Promise<string> {
  const schema = schemaName();
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await pool.end();
  }

  return schema;
}

async function dropSchema(schema: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await pool.end();
  }
}

describe('board lifecycle mutations', { concurrent: false }, () => {
  test('writes an allowed transition with its history and lifecycle event', async () => {
    const schema = await createSchema();
    const database = createDatabase(databaseUrl, schema);
    const board = createBoard(database);
    const projectId = crypto.randomUUID();
    const itemId = crypto.randomUUID();

    try {
      await migrateToLatest(database, schema);
      await board.createProject({ id: projectId, name: 'Test project' });
      await board.createWorkItem({ id: itemId, projectId });

      const result = await board.transition(itemId, {
        actor: { role: 'navigator' },
        priority: 'P1',
        record: { kind: 'triage' },
        to: 'build_ready',
      });

      expect(result).toMatchObject({
        ok: true,
        item: { holderRunId: null, priority: 'P1', state: 'build_ready' },
      });
      expect(
        await database
          .selectFrom('work_item_history')
          .select(['actor_role', 'from_state', 'to_state'])
          .where('work_item_id', '=', itemId)
          .execute(),
      ).toEqual([
        {
          actor_role: 'navigator',
          from_state: 'new',
          to_state: 'build_ready',
        },
      ]);
      expect(
        await database
          .selectFrom('lifecycle_events')
          .select(['kind', 'work_item_id'])
          .where('work_item_id', '=', itemId)
          .execute(),
      ).toEqual([{ kind: 'transition', work_item_id: itemId }]);
      expect(
        await database
          .selectFrom('work_item_records')
          .select(['kind', 'work_item_id'])
          .where('work_item_id', '=', itemId)
          .execute(),
      ).toEqual([{ kind: 'triage', work_item_id: itemId }]);
    } finally {
      await database.destroy();
      await dropSchema(schema);
    }
  });

  test('claims an item and creates its fake run in one transaction', async () => {
    const schema = await createSchema();
    const database = createDatabase(databaseUrl, schema);
    const board = createBoard(database);
    const projectId = crypto.randomUUID();
    const itemId = crypto.randomUUID();

    try {
      await migrateToLatest(database, schema);
      await board.createProject({ id: projectId, name: 'Test project' });
      await board.createWorkItem({
        id: itemId,
        priority: 'P1',
        projectId,
        state: 'build_ready',
      });

      const result = await board.claim(itemId, 'builder');

      expect(result).toMatchObject({
        ok: true,
        item: { state: 'building' },
      });
      if (!result.ok) {
        throw new Error(result.reason);
      }
      expect(result.item.holderRunId).not.toBeNull();
      expect(
        await database
          .selectFrom('runs')
          .select(['id', 'role', 'status'])
          .where('id', '=', result.item.holderRunId ?? '')
          .executeTakeFirstOrThrow(),
      ).toEqual({
        id: result.item.holderRunId,
        role: 'builder',
        status: 'active',
      });
    } finally {
      await database.destroy();
      await dropSchema(schema);
    }
  });

  test('serializes competing claims so only one fake run holds the item', async () => {
    const schema = await createSchema();
    const database = createDatabase(databaseUrl, schema);
    const board = createBoard(database);
    const projectId = crypto.randomUUID();
    const itemId = crypto.randomUUID();

    try {
      await migrateToLatest(database, schema);
      await board.createProject({ id: projectId, name: 'Test project' });
      await board.createWorkItem({
        id: itemId,
        priority: 'P1',
        projectId,
        state: 'build_ready',
      });

      const results = await Promise.all([
        board.claim(itemId, 'builder'),
        board.claim(itemId, 'builder'),
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([
        {
          ok: false,
          reason: 'backend cannot move a work item from building to building.',
        },
      ]);
      expect(
        await database
          .selectFrom('work_items')
          .select(['holder_run_id', 'state'])
          .where('id', '=', itemId)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ holder_run_id: expect.any(String), state: 'building' });
      expect(
        await database.selectFrom('runs').select('id').execute(),
      ).toHaveLength(1);
    } finally {
      await database.destroy();
      await dropSchema(schema);
    }
  });
});
