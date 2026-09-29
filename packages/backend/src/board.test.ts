import { Pool } from 'pg';
import { describe, expect, test } from 'vitest';

import {
  createBoard,
  filingLockKey,
  ProjectNotFoundError,
  WorkItemNotFoundError,
} from './board.js';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrations/index.js';
import { withTestDatabase } from './test-support.js';

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
  test('files work in commit order so a list snapshot never skips an item', async () => {
    const schema = await createSchema();
    const database = createDatabase(databaseUrl, schema);
    const board = createBoard(database);
    const projectId = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    const pool = new Pool({ connectionString: databaseUrl });
    const holder = await pool.connect();

    try {
      await migrateToLatest(database, schema);
      await board.createProject({ id: projectId, name: 'Test project' });
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1)', [filingLockKey]);

      let filed = false;
      const filing = board
        .createWorkItem({ id: itemId, projectId, title: 'Waits its turn' })
        .then(() => {
          filed = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(filed).toBe(false);
      await holder.query('COMMIT');
      await filing;
      const page = await board.listWorkItems(projectId);
      expect(page.items.map((item) => item.id)).toEqual([itemId]);
    } finally {
      holder.release();
      await pool.end();
      await database.destroy();
      await dropSchema(schema);
    }
  });

  test('files, reads and triages work without treating its history as empty', async () => {
    const schema = await createSchema();
    const database = createDatabase(databaseUrl, schema);
    const board = createBoard(database);
    const projectId = crypto.randomUUID();
    const itemId = crypto.randomUUID();

    try {
      await migrateToLatest(database, schema);
      await board.createProject({ id: projectId, name: 'Test project' });
      await board.createWorkItem({
        description: 'Make the board useful for navigating project work.',
        id: itemId,
        projectId,
        title: 'Show the project board',
      });

      expect((await board.listWorkItems(projectId)).items).toEqual([
        expect.objectContaining({
          description: 'Make the board useful for navigating project work.',
          id: itemId,
          priority: null,
          state: 'new',
          title: 'Show the project board',
        }),
      ]);

      const result = await board.transition(itemId, {
        actor: { role: 'navigator' },
        priority: 'P1',
        record: { kind: 'triage' },
        to: 'build_ready',
      });
      expect(result).toMatchObject({ ok: true });
      expect(await board.getHistory(itemId)).toEqual([
        expect.objectContaining({
          fromState: 'new',
          toState: 'build_ready',
        }),
      ]);
    } finally {
      await database.destroy();
      await dropSchema(schema);
    }
  });

  test('searches, filters, sorts and pages within a stable snapshot', async () => {
    const schema = await createSchema();
    const database = createDatabase(databaseUrl, schema);
    const board = createBoard(database);
    const projectId = crypto.randomUUID();
    const otherProjectId = crypto.randomUUID();

    try {
      await migrateToLatest(database, schema);
      await board.createProject({ id: projectId, name: 'Test project' });
      await board.createProject({ id: otherProjectId, name: 'Other' });
      const file = async (title: string, extra: object = {}) => {
        const id = crypto.randomUUID();
        await board.createWorkItem({ id, projectId, title, ...extra });
        return id;
      };
      const first = await file('Alpha board', {
        description: 'mentions Zebra',
      });
      const second = await file('Beta', {
        priority: 'P3',
        state: 'build_ready',
      });
      const third = await file('Gamma board', {
        priority: 'P0',
        state: 'build_ready',
      });
      await board.createWorkItem({
        id: crypto.randomUUID(),
        projectId: otherProjectId,
        title: 'Elsewhere board',
      });

      const ids = (page: { items: readonly { id: string }[] }) =>
        page.items.map((item) => item.id);

      expect(ids(await board.listWorkItems(projectId))).toEqual([
        third,
        second,
        first,
      ]);
      expect(
        ids(await board.listWorkItems(projectId, { sort: 'oldest' })),
      ).toEqual([first, second, third]);
      expect(
        ids(await board.listWorkItems(projectId, { sort: 'priority' })),
      ).toEqual([third, second, first]);
      expect(
        ids(await board.listWorkItems(projectId, { search: 'BOARD' })),
      ).toEqual([third, first]);
      expect(
        ids(await board.listWorkItems(projectId, { search: 'zebra' })),
      ).toEqual([first]);
      expect(
        ids(await board.listWorkItems(projectId, { state: 'new' })),
      ).toEqual([first]);
      expect(
        ids(await board.listWorkItems(projectId, { priority: 'P3' })),
      ).toEqual([second]);
      expect(
        ids(await board.listWorkItems(projectId, { priority: 'none' })),
      ).toEqual([first]);

      const page = await board.listWorkItems(projectId, { limit: 2 });
      expect(ids(page)).toEqual([third, second]);
      expect(page.nextCursor).not.toBeNull();
      expect(page.total).toBe(3);

      const arrival = await file('Delta board');
      const next = await board.listWorkItems(projectId, {
        cursor: page.nextCursor ?? undefined,
        limit: 2,
        snapshot: page.snapshot,
      });
      expect(ids(next)).toEqual([first]);
      expect(next.nextCursor).toBeNull();
      expect(
        await board.countArrivals(projectId, { snapshot: page.snapshot }),
      ).toBe(1);
      expect(
        await board.countArrivals(projectId, {
          search: 'nothing like it',
          snapshot: page.snapshot,
        }),
      ).toBe(0);
      expect(ids(await board.listWorkItems(projectId))[0]).toBe(arrival);
    } finally {
      await database.destroy();
      await dropSchema(schema);
    }
  });

  test('refuses a route the project does not support without writing', async () => {
    const schema = await createSchema();
    const database = createDatabase(databaseUrl, schema);
    const board = createBoard(database);
    const projectId = crypto.randomUUID();
    const itemId = crypto.randomUUID();

    try {
      await migrateToLatest(database, schema);
      await board.createProject({
        id: projectId,
        name: 'No design',
        stages: { design: false },
      });
      await board.createWorkItem({ id: itemId, projectId, title: 'Item' });

      expect(await board.triage(itemId, 'P1', 'design_ready')).toEqual({
        code: 'route_unavailable',
        ok: false,
        reason: 'That next step is not available for this project.',
      });
      expect(await board.getWorkItem(itemId)).toMatchObject({
        priority: null,
        state: 'new',
      });
      expect(await board.getHistory(itemId)).toEqual([]);

      expect(await board.triage(itemId, 'P2', 'build_ready')).toMatchObject({
        ok: true,
        item: { priority: 'P2', state: 'build_ready' },
      });
    } finally {
      await database.destroy();
      await dropSchema(schema);
    }
  });

  test('reports an unknown work item as missing rather than empty', async () => {
    const schema = await createSchema();
    const database = createDatabase(databaseUrl, schema);
    const board = createBoard(database);

    try {
      await migrateToLatest(database, schema);
      await expect(board.listWorkItems(crypto.randomUUID())).rejects.toThrow(
        ProjectNotFoundError,
      );
      await expect(board.getWorkItem(crypto.randomUUID())).rejects.toThrow(
        WorkItemNotFoundError,
      );
      await expect(
        board.triage(crypto.randomUUID(), 'P1', 'build_ready'),
      ).rejects.toThrow(WorkItemNotFoundError);
      await expect(board.getHistory(crypto.randomUUID())).rejects.toThrow(
        WorkItemNotFoundError,
      );
      await expect(board.listComments(crypto.randomUUID())).rejects.toThrow(
        WorkItemNotFoundError,
      );
      await expect(
        board.addComment(crypto.randomUUID(), 'Hello'),
      ).rejects.toThrow(WorkItemNotFoundError);
    } finally {
      await database.destroy();
      await dropSchema(schema);
    }
  });

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

describe('provenance and records', { concurrent: false }, () => {
  test('keeps who filed an item and the item it was discovered from', async () => {
    await withTestDatabase(async (database) => {
      const board = createBoard(database);
      const projectId = crypto.randomUUID();
      const heldId = crypto.randomUUID();
      const filedId = crypto.randomUUID();
      const navigatorsId = crypto.randomUUID();
      await board.createProject({ id: projectId, name: 'Test project' });
      await board.createWorkItem({
        id: heldId,
        priority: 'P1',
        projectId,
        state: 'grooming_ready',
      });
      const claimed = await board.claim(heldId, 'groomer');
      if (!claimed.ok) throw new Error(claimed.reason);
      const runId = claimed.item.holderRunId ?? '';
      await database
        .updateTable('runs')
        .set({ agent_name: 'Jubilee' })
        .where('id', '=', runId)
        .execute();

      await board.createWorkItem({
        discoveredFromId: heldId,
        filedByRunId: runId,
        id: filedId,
        projectId,
        title: 'Export as XLSX too',
      });
      await board.createWorkItem({ id: navigatorsId, projectId });

      expect(await board.getProvenance(filedId)).toEqual({
        discoveredFromId: heldId,
        filedBy: { agentName: 'Jubilee', role: 'groomer', runId },
      });
      expect(await board.getProvenance(navigatorsId)).toEqual({
        discoveredFromId: null,
        filedBy: null,
      });
      await expect(
        board.getProvenance(crypto.randomUUID()),
      ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    });
  });

  test('lists an item’s records in the order they were appended', async () => {
    await withTestDatabase(async (database) => {
      const board = createBoard(database);
      const projectId = crypto.randomUUID();
      const itemId = crypto.randomUUID();
      await board.createProject({ id: projectId, name: 'Test project' });
      await board.createWorkItem({ id: itemId, projectId });
      await board.triage(itemId, 'P2', 'build_ready');
      await board.claim(itemId, 'builder');

      const records = await board.listRecords(itemId);

      expect(records.map((entry) => entry.kind)).toEqual(['triage', 'claim']);
      expect(records[1]?.record).toEqual({ kind: 'claim', role: 'builder' });
      expect(records[0]?.createdAt).toBeInstanceOf(Date);
      await expect(
        board.listRecords(crypto.randomUUID()),
      ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    });
  });
});
