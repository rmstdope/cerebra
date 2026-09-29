import { Pool } from 'pg';
import { describe, expect, test } from 'vitest';

import {
  createBoard,
  filingLockKey,
  ProjectNotFoundError,
  recordForHeldItem,
  WorkItemNotFoundError,
} from './board.js';
import { createDatabase } from './database.js';
import { migrateToLatest } from './migrations/index.js';
import { createRunStore } from './runs.js';
import {
  agentNamed,
  registerTestProject,
  withTestDatabase,
} from './test-support.js';

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

  test('lists who filed each item, and what it was discovered from', async () => {
    await withTestDatabase(async (database) => {
      const board = createBoard(database);
      const projectId = await registerTestProject(database);
      const runs = createRunStore(database);
      const run = async (name: string, role: 'groomer' | 'assistant') =>
        (
          await runs.create({
            agentId: await agentNamed(database, projectId, name),
            agentName: name,
            projectId,
            role,
            tokenHash: crypto.randomUUID(),
          })
        ).id;
      const groomer = await run('Jubilee', 'groomer');
      const assistant = await run('Cerebro', 'assistant');
      const originalId = crypto.randomUUID();
      await board.createWorkItem({
        id: originalId,
        projectId,
        title: 'Export invoices as CSV',
      });
      const narrowedId = crypto.randomUUID();
      await board.createWorkItem({
        discoveredFromId: originalId,
        filedByRunId: groomer,
        id: narrowedId,
        projectId,
        title: 'Bulk export for credit notes',
      });
      const chattedId = crypto.randomUUID();
      await board.createWorkItem({
        filedByRunId: assistant,
        id: chattedId,
        projectId,
        title: 'Dark mode',
      });

      const filedBy = Object.fromEntries(
        (await board.listWorkItems(projectId)).items.map((item) => [
          item.id,
          item.filedBy,
        ]),
      );

      expect(filedBy).toEqual({
        [chattedId]: {
          agentName: 'Cerebro',
          discoveredFrom: null,
          role: 'assistant',
        },
        [narrowedId]: {
          agentName: 'Jubilee',
          discoveredFrom: { id: originalId, title: 'Export invoices as CSV' },
          role: 'groomer',
        },
        [originalId]: null,
      });
    });
  });
  test('keys each item within its project and keeps the type it was filed as', async () => {
    await withTestDatabase(async (database) => {
      const board = createBoard(database);
      const projectId = await registerTestProject(database);
      const feature = crypto.randomUUID();
      const bug = crypto.randomUUID();
      await board.createWorkItem({ id: feature, projectId, title: 'Export' });
      await board.createWorkItem({
        id: bug,
        projectId,
        title: 'Crash',
        type: 'bug',
      });

      expect(await board.getWorkItem(feature)).toMatchObject({
        key: 'WEB-1',
        type: 'feature',
      });
      expect(
        (await board.listWorkItems(projectId)).items.map((item) => [
          item.key,
          item.type,
        ]),
      ).toEqual([
        ['WEB-2', 'bug'],
        ['WEB-1', 'feature'],
      ]);
    });
  });

  test('hands an item to review only after its holder recorded a plan and passing checks', async () => {
    await withTestDatabase(async (database) => {
      const board = createBoard(database);
      const projectId = await registerTestProject(database);
      const itemId = crypto.randomUUID();
      await board.createWorkItem({ id: itemId, projectId, title: 'Export' });
      await board.triage(itemId, 'P2', 'build_ready');
      const claimed = await board.claim(itemId, 'builder');
      if (!claimed.ok) throw new Error(claimed.reason);
      const runId = claimed.item.holderRunId ?? '';
      const handOver = () =>
        board.transition(itemId, {
          actor: { role: 'builder', runId },
          record: {
            branch: 'WEB-1-export',
            head: '0123456789abcdef0123456789abcdef01234567',
            kind: 'pull_request',
            url: 'https://github.com/acme/website/pull/7',
          },
          to: 'review_ready',
        });

      expect(await handOver()).toMatchObject({
        ok: false,
        reason: expect.stringContaining('submit_plan'),
      });
      expect(
        await recordForHeldItem(database, itemId, crypto.randomUUID(), {
          kind: 'plan',
          markdown: '',
        }),
      ).toMatchObject({ code: 'nothing_held', ok: false });
      expect(
        await recordForHeldItem(database, itemId, runId, {
          kind: 'plan',
          markdown: 'plan',
        }),
      ).toEqual({ ok: true });
      expect(await handOver()).toMatchObject({
        ok: false,
        reason: expect.stringContaining('report_checks'),
      });
      await recordForHeldItem(database, itemId, runId, {
        kind: 'checks',
        passed: false,
        summary: 'lint failed',
      });
      expect(await handOver()).toMatchObject({
        ok: false,
        reason: expect.stringContaining('The latest checks failed'),
      });
      await recordForHeldItem(database, itemId, runId, {
        kind: 'checks',
        passed: true,
        summary: 'all green',
      });

      expect(await handOver()).toMatchObject({
        ok: true,
        item: { state: 'review_ready' },
      });
      const records = await database
        .selectFrom('work_item_records')
        .select(['kind', 'run_id'])
        .where('kind', 'in', ['plan', 'checks', 'pull_request'])
        .orderBy('id')
        .execute();
      expect(records).toEqual([
        { kind: 'plan', run_id: runId },
        { kind: 'checks', run_id: runId },
        { kind: 'checks', run_id: runId },
        { kind: 'pull_request', run_id: runId },
      ]);
      expect(
        await recordForHeldItem(database, itemId, runId, {
          kind: 'checks',
          passed: true,
        }),
      ).toMatchObject({ code: 'nothing_held', ok: false });
    });
  });

  test('tells an item’s delivery story in order, fifty events at a time', async () => {
    await withTestDatabase(async (database) => {
      const board = createBoard(database);
      const projectId = await registerTestProject(database);
      const itemId = crypto.randomUUID();
      await board.createWorkItem({ id: itemId, projectId, title: 'Export' });

      expect(await board.deliveryActivity(itemId)).toEqual({
        current: null,
        earlierCursor: null,
        events: [],
        latestChecks: null,
        latestPullRequest: null,
      });

      await board.triage(itemId, 'P2', 'build_ready');
      const claimed = await board.claim(itemId, 'builder');
      if (!claimed.ok) throw new Error(claimed.reason);
      const runId = claimed.item.holderRunId ?? '';
      await database
        .updateTable('runs')
        .set({ agent_name: 'Wolverine' })
        .where('id', '=', runId)
        .execute();
      await recordForHeldItem(database, itemId, runId, {
        kind: 'plan',
        markdown: 'plan',
      });
      for (let index = 0; index < 54; index += 1) {
        await recordForHeldItem(database, itemId, runId, {
          kind: 'checks',
          passed: index % 2 === 1,
        });
      }
      await board.transition(itemId, {
        actor: { role: 'builder', runId },
        record: {
          branch: 'WEB-1-export',
          head: '0123456789abcdef0123456789abcdef01234567',
          kind: 'pull_request',
          title: 'Export invoices',
          url: 'https://github.com/acme/website/pull/482',
        },
        to: 'review_ready',
      });

      const latest = await board.deliveryActivity(itemId);
      expect(latest.events).toHaveLength(50);
      expect(latest.events.at(-1)).toMatchObject({
        agentName: 'Wolverine',
        kind: 'pull_request',
        number: 482,
        runId,
        title: 'Export invoices',
        url: 'https://github.com/acme/website/pull/482',
      });
      expect(latest.current).toEqual({
        kind: 'waiting_for_review',
        reviewer: 'Emma',
      });
      expect(latest.latestChecks).toMatchObject({
        kind: 'checks',
        passed: true,
      });
      expect(latest.latestPullRequest).toMatchObject({ number: 482 });
      expect(latest.earlierCursor).not.toBeNull();

      const earlier = await board.deliveryActivity(itemId, {
        before: latest.earlierCursor ?? '',
      });
      expect(earlier.earlierCursor).toBeNull();
      expect(earlier.events.map((event) => event.kind)).toEqual([
        'plan',
        'checks',
        'checks',
        'checks',
        'checks',
        'checks',
      ]);
      expect(earlier.events[0]).toMatchObject({ agentName: 'Wolverine' });
      expect(
        [...earlier.events, ...latest.events].map((event) => Number(event.id)),
      ).toEqual(
        [...earlier.events, ...latest.events]
          .map((event) => Number(event.id))
          .toSorted((a, b) => a - b),
      );
      await expect(
        board.deliveryActivity(crypto.randomUUID()),
      ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    });
  });
});
