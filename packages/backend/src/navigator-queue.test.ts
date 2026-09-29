import { Pool } from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';
import type { Kysely } from 'kysely';

import { createBoard, WorkItemNotFoundError, type Board } from './board.js';
import { createDatabase, type Database } from './database.js';
import type { WaitingKind, WorkItemState } from './lifecycle.js';
import { migrateToLatest } from './migrations/index.js';
import {
  createNavigatorQueue,
  type NavigatorQueue,
} from './navigator-queue.js';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to run navigator queue tests');
}

const url = databaseUrl;

async function withPool<T extends object = object>(
  query: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const pool = new Pool({ connectionString: url });
  try {
    return (await pool.query<T>(query, [...values])).rows;
  } finally {
    await pool.end();
  }
}

describe('navigator queue', { concurrent: false }, () => {
  let schema: string;
  let database: Kysely<Database>;
  let board: Board;
  let queue: NavigatorQueue;
  const alpha = crypto.randomUUID();
  const beta = crypto.randomUUID();

  // One schema per file, migrated once; tests truncate rather than re-migrate.
  beforeAll(async () => {
    schema = `cerebra_queue_test_${crypto.randomUUID().replaceAll('-', '')}`;
    await withPool(`CREATE SCHEMA "${schema}"`);
    database = createDatabase(url, schema);
    await migrateToLatest(database, schema);
    board = createBoard(database);
    queue = createNavigatorQueue(database);
  });

  afterAll(async () => {
    await database.destroy();
    await withPool(`DROP SCHEMA "${schema}" CASCADE`);
  });

  beforeEach(async () => {
    const tables = await withPool<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename NOT LIKE 'kysely%'",
      [schema],
    );
    const names = tables
      .map(({ tablename }) => `"${schema}"."${tablename}"`)
      .join(', ');
    await withPool(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
    await board.createProject({ id: alpha, name: 'alpha' });
    await board.createProject({ id: beta, name: 'beta' });
    await database
      .updateTable('projects')
      .set({ owner: 'acme' })
      .where('id', '=', alpha)
      .execute();
  });

  async function file(
    projectId: string,
    title: string,
    state: WorkItemState = 'new',
    priority: 'P0' | 'P1' | 'P2' | 'P3' | undefined = undefined,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await board.createWorkItem({
      id,
      priority: state === 'new' ? undefined : (priority ?? 'P2'),
      projectId,
      state,
      title,
    });
    return id;
  }

  async function wait(
    id: string,
    kind: WaitingKind,
    reason: string,
    returnState: WorkItemState,
  ): Promise<void> {
    const result = await board.transition(id, {
      actor: { role: 'backend' },
      to: 'waiting',
      waiting: { kind, reason, returnState },
    });
    expect(result.ok).toBe(true);
  }

  async function question(projectId: string, title: string): Promise<string> {
    const id = await file(projectId, title, 'grooming_ready');
    const claimed = await board.claim(id, 'groomer');
    if (!claimed.ok) throw new Error(claimed.reason);
    const asked = await board.transition(id, {
      actor: { role: 'groomer', runId: claimed.item.holderRunId ?? '' },
      to: 'waiting',
      waiting: {
        kind: 'question',
        reason: 'Which release should we support?',
        returnState: 'grooming_ready',
      },
    });
    expect(asked.ok).toBe(true);
    return id;
  }

  test('lists new and waiting items from every project, grouped and most urgent first', async () => {
    const betaNew = await file(beta, 'Make reports easier to share');
    const alphaNew = await file(alpha, 'Tidy the settings');
    const lowAttention = await file(alpha, 'Low', 'build_ready', 'P3');
    await wait(lowAttention, 'escalation', 'Attempts ran out.', 'build_ready');
    const urgentAttention = await file(alpha, 'Urgent', 'build_ready', 'P0');
    await wait(urgentAttention, 'escalation', 'Sign-in fails.', 'build_ready');
    const review = await file(alpha, 'Check the change', 'merging');
    await wait(review, 'code_review', 'Ready for your review.', 'merging');
    const asked = await question(alpha, 'Which release?');
    await file(alpha, 'Being built', 'build_ready').then((id) =>
      board.claim(id, 'builder'),
    );
    await file(alpha, 'Finished', 'done');
    await file(beta, 'Dropped', 'cancelled');

    const page = await queue.list();

    expect(page.total).toBe(6);
    expect(page.entries.map((entry) => entry.id)).toEqual([
      urgentAttention,
      lowAttention,
      asked,
      review,
      alphaNew,
      betaNew,
    ]);
    expect(page.entries.map((entry) => entry.kind)).toEqual([
      'attention',
      'attention',
      'question',
      'review',
      'new',
      'new',
    ]);
    expect(page.entries[0]).toMatchObject({
      askedBy: null,
      availableRoutes: ['grooming_ready', 'design_ready', 'build_ready'],
      priority: 'P0',
      projectId: alpha,
      projectName: 'acme/alpha',
      title: 'Urgent',
      waitingReason: 'Sign-in fails.',
    });
    expect(page.entries[2]).toMatchObject({
      askedBy: 'Groomer',
      kind: 'question',
      waitingReason: 'Which release should we support?',
    });
    expect(page.entries[5]).toMatchObject({
      priority: null,
      projectName: 'beta',
      waitingReason: null,
    });
  });

  test('names the backend as Cerebra when it asked', async () => {
    const id = await file(alpha, 'Asked by the system', 'build_ready');
    await wait(id, 'question', 'Is this still wanted?', 'build_ready');

    const page = await queue.list();

    expect(page.entries[0]).toMatchObject({ askedBy: 'Cerebra', id });
  });

  test('offers only the next steps the project has switched on', async () => {
    const lean = crypto.randomUUID();
    await board.createProject({
      id: lean,
      name: 'lean',
      stages: { design: false, grooming: false },
    });
    await file(lean, 'Small fix');

    const page = await queue.list();

    expect(page.entries[0]?.availableRoutes).toEqual(['build_ready']);
  });

  test('answers a question, records the answer and returns the item', async () => {
    const id = await question(alpha, 'Which release?');

    const result = await queue.answer(id, 'The current release only.');

    expect(result).toEqual({ ok: true });
    expect(await board.getWorkItem(id)).toMatchObject({
      state: 'grooming_ready',
    });
    const records = await database
      .selectFrom('work_item_records')
      .select(['kind', 'payload'])
      .where('work_item_id', '=', id)
      .where('kind', '=', 'answer')
      .execute();
    expect(records).toEqual([
      {
        kind: 'answer',
        payload: {
          answer: 'The current release only.',
          kind: 'answer',
          question: 'Which release should we support?',
        },
      },
    ]);
    expect((await queue.list()).entries).toEqual([]);
  });

  test('refuses to answer anything but a waiting question', async () => {
    const id = await file(alpha, 'New work');

    expect(await queue.answer(id, 'Yes.')).toMatchObject({
      code: 'not_waiting',
      ok: false,
    });
    await expect(
      queue.answer(crypto.randomUUID(), 'Yes.'),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  test('reopens a wait to the state it was waiting to return to', async () => {
    const id = await file(alpha, 'Stuck', 'design_ready');
    await wait(id, 'escalation', 'Attempts ran out.', 'design_ready');

    expect(await queue.decide(id, { direction: 'reopen' })).toEqual({
      ok: true,
    });
    expect(await board.getWorkItem(id)).toMatchObject({
      state: 'design_ready',
    });
  });

  test('reopens a review to be built again', async () => {
    const id = await file(alpha, 'Check it', 'merging');
    await wait(id, 'code_review', 'Ready for your review.', 'merging');

    await queue.decide(id, { direction: 'reopen' });

    expect(await board.getWorkItem(id)).toMatchObject({
      state: 'build_ready',
    });
  });

  test('cancels with the reason in its history', async () => {
    const id = await file(alpha, 'Not needed');

    await queue.decide(id, { direction: 'cancel', reason: 'Duplicate.' });

    expect(await board.getWorkItem(id)).toMatchObject({ state: 'cancelled' });
    expect((await board.getHistory(id)).at(-1)).toMatchObject({
      actorRole: 'navigator',
      reason: 'Duplicate.',
      toState: 'cancelled',
    });
  });

  test('redirects new work with a priority, and a wait, with the reason', async () => {
    const fresh = await file(alpha, 'Fresh');
    const stuck = await file(alpha, 'Stuck', 'build_ready', 'P1');
    await wait(stuck, 'escalation', 'Attempts ran out.', 'build_ready');

    expect(
      await queue.decide(fresh, {
        direction: 'redirect',
        priority: 'P1',
        reason: 'Clear enough to design.',
        to: 'design_ready',
      }),
    ).toEqual({ ok: true });
    await queue.decide(stuck, {
      direction: 'redirect',
      reason: 'Needs grooming first.',
      to: 'grooming_ready',
    });

    expect(await board.getWorkItem(fresh)).toMatchObject({
      priority: 'P1',
      state: 'design_ready',
    });
    expect((await board.getHistory(fresh)).at(-1)?.reason).toBe(
      'Clear enough to design.',
    );
    expect(await board.getWorkItem(stuck)).toMatchObject({
      priority: 'P1',
      state: 'grooming_ready',
    });
    expect((await board.getHistory(stuck)).at(-1)?.reason).toBe(
      'Needs grooming first.',
    );
  });

  test('refuses a redirect to a switched-off stage or without a priority', async () => {
    const lean = crypto.randomUUID();
    await board.createProject({
      id: lean,
      name: 'lean',
      stages: { design: false },
    });
    const id = await file(lean, 'Small fix');

    expect(
      await queue.decide(id, {
        direction: 'redirect',
        priority: 'P2',
        reason: 'Design it.',
        to: 'design_ready',
      }),
    ).toMatchObject({ code: 'route_unavailable', ok: false });
    expect(
      await queue.decide(id, {
        direction: 'redirect',
        reason: 'Build it.',
        to: 'build_ready',
      }),
    ).toMatchObject({ code: 'refused', ok: false });
    expect(await board.getWorkItem(id)).toMatchObject({ state: 'new' });
  });

  test('refuses a decision on work that no longer waits on the navigator', async () => {
    const id = await file(alpha, 'Queued', 'build_ready');

    expect(
      await queue.decide(id, { direction: 'cancel', reason: 'Stale.' }),
    ).toMatchObject({ code: 'not_waiting', ok: false });
    expect(await queue.decide(id, { direction: 'reopen' })).toMatchObject({
      code: 'not_waiting',
      ok: false,
    });
    expect(await board.getWorkItem(id)).toMatchObject({ state: 'build_ready' });
  });
});
