import type { Kysely } from 'kysely';
import { describe, expect, test } from 'vitest';

import { createBoard, type Board } from './board.js';
import {
  createBoardTools,
  resolveCaller,
  type ToolCaller,
} from './board-tools.js';
import type { Database } from './database.js';
import type { WorkItemState } from './lifecycle.js';
import { hashRunToken } from './runner-gateway.js';
import { createRunStore } from './runs.js';
import {
  agentNamed,
  registerTestProject,
  withTestDatabase,
} from './test-support.js';

type RunRole = Database['runs']['role'];

const outcome = {
  kind: 'outcome',
  markdown: [
    '## Problem',
    'Exports are CSV only.',
    '## Who benefits',
    'Accountants.',
    '## Outcome',
    'An XLSX export.',
    '## Out of scope',
    'None. Nothing else changes.',
    '## How we will know',
    'The file opens in Excel.',
    '## Route',
    'build',
  ].join('\n'),
};

interface Fixture {
  readonly board: Board;
  readonly database: Kysely<Database>;
  readonly projectId: string;
  readonly tools: ReturnType<typeof createBoardTools>;
  caller(name: string, role: RunRole, projectId?: string): Promise<ToolCaller>;
  item(options?: {
    readonly heldBy?: ToolCaller;
    readonly projectId?: string;
    readonly state?: WorkItemState;
    readonly title?: string;
  }): Promise<string>;
}

async function withBoard(run: (fixture: Fixture) => Promise<void>) {
  await withTestDatabase(async (database) => {
    const board = createBoard(database);
    const projectId = await registerTestProject(database);
    const runs = createRunStore(database);
    await run({
      board,
      database,
      projectId,
      tools: createBoardTools({ board, database }),
      async caller(name, role, inProject = projectId) {
        const token = crypto.randomUUID();
        await runs.create({
          agentId: await agentNamed(database, inProject, name),
          agentName: name,
          projectId: inProject,
          role,
          tokenHash: hashRunToken(token),
        });
        const caller = await resolveCaller(database, hashRunToken(token));
        if (caller === null) throw new Error('no caller');
        return caller;
      },
      async item({
        heldBy,
        projectId: inProject = projectId,
        state = 'grooming_ready',
        title = 'Export as XLSX',
      } = {}) {
        const id = crypto.randomUUID();
        await board.createWorkItem({
          id,
          priority: 'P1',
          projectId: inProject,
          state,
          title,
        });
        if (heldBy !== undefined) {
          const claimed = await board.transition(id, {
            actor: { role: 'backend', runId: heldBy.runId },
            record: { kind: 'claim', role: heldBy.role },
            to: 'grooming',
          });
          if (!claimed.ok) throw new Error(claimed.reason);
        }
        return id;
      },
    });
  });
}

describe('resolveCaller', { concurrent: false }, () => {
  test('answers the live run’s project, role and allowed tools', async () => {
    await withBoard(async ({ caller, projectId }) => {
      const jubilee = await caller('Jubilee', 'groomer');

      expect(jubilee).toMatchObject({
        agentName: 'Jubilee',
        projectId,
        role: 'groomer',
      });
      expect([...jubilee.tools].sort()).toEqual([
        'comment',
        'create_item',
        'get_item',
        'list_items',
        'transition',
        'wait_for_navigator',
      ]);
    });
  });

  test('answers no caller for an ended run or an unknown token', async () => {
    await withBoard(async ({ caller, database }) => {
      const jubilee = await caller('Jubilee', 'groomer');
      const token = hashRunToken('ended');
      await database
        .updateTable('runs')
        .set({ status: 'finished', token_hash: token })
        .where('id', '=', jubilee.runId)
        .execute();

      expect(await resolveCaller(database, token)).toBeNull();
      expect(await resolveCaller(database, hashRunToken('never'))).toBeNull();
    });
  });
});

describe('board tools', { concurrent: false }, () => {
  test('lists only the implemented tools the type allows', async () => {
    await withBoard(async ({ caller, tools }) => {
      const assistant = await caller('Cerebro', 'assistant');

      expect(
        tools
          .list(assistant)
          .map((tool) => tool.name)
          .sort(),
      ).toEqual(['comment', 'create_item', 'get_item', 'list_items']);
      expect(
        tools
          .list(assistant)
          .every((tool) => tool.inputSchema.type === 'object'),
      ).toBe(true);
    });
  });

  test('reads items of the run’s project', async () => {
    await withBoard(async ({ board, caller, item, tools }) => {
      const jubilee = await caller('Jubilee', 'groomer');
      const itemId = await item({ title: 'Export as XLSX' });
      await board.addComment(itemId, 'Customers asked twice.');

      const listed = await tools.call(jubilee, 'list_items', {
        state: 'grooming_ready',
      });
      const read = await tools.call(jubilee, 'get_item', { item_id: itemId });

      expect(listed).toMatchObject({
        ok: true,
        value: { items: [{ id: itemId, title: 'Export as XLSX' }], total: 1 },
      });
      expect(read).toMatchObject({
        ok: true,
        value: {
          comments: [{ body: 'Customers asked twice.' }],
          item: { id: itemId, priority: 'P1', state: 'grooming_ready' },
          provenance: { discoveredFromId: null, filedBy: null },
          records: [],
        },
      });
    });
  });

  test('files an agent’s item into new, unranked, with its provenance', async () => {
    await withBoard(async ({ board, caller, item, tools }) => {
      const jubilee = await caller('Jubilee', 'groomer');
      const heldId = await item({ heldBy: jubilee });

      const filed = await tools.call(jubilee, 'create_item', {
        description: 'Spreadsheets too.',
        priority: 'P0',
        state: 'build_ready',
        title: 'Export as ODS',
      });

      expect(filed.ok).toBe(true);
      const filedId = (filed as { value: { id: string } }).value.id;
      expect(await board.getWorkItem(filedId)).toMatchObject({
        description: 'Spreadsheets too.',
        priority: null,
        state: 'new',
        title: 'Export as ODS',
      });
      expect(await board.getProvenance(filedId)).toEqual({
        discoveredFromId: heldId,
        filedBy: {
          agentName: 'Jubilee',
          role: 'groomer',
          runId: jubilee.runId,
        },
      });
    });
  });

  test('files an item with no discovered-from when the run holds nothing', async () => {
    await withBoard(async ({ board, caller, tools }) => {
      const assistant = await caller('Cerebro', 'assistant');

      const filed = await tools.call(assistant, 'create_item', {
        title: 'Dark mode',
      });

      const filedId = (filed as { value: { id: string } }).value.id;
      expect(await board.getProvenance(filedId)).toMatchObject({
        discoveredFromId: null,
        filedBy: { runId: assistant.runId },
      });
    });
  });

  test('comments on the held item by default, or on a named one', async () => {
    await withBoard(async ({ board, caller, item, tools }) => {
      const jubilee = await caller('Jubilee', 'groomer');
      const heldId = await item({ heldBy: jubilee });
      const otherId = await item();

      await tools.call(jubilee, 'comment', { body: 'Held.' });
      await tools.call(jubilee, 'comment', {
        body: 'Other.',
        item_id: otherId,
      });

      expect(await board.listComments(heldId)).toMatchObject([
        { body: 'Held.' },
      ]);
      expect(await board.listComments(otherId)).toMatchObject([
        { body: 'Other.' },
      ]);
    });
  });

  test('moves the held item through the lifecycle with its record', async () => {
    await withBoard(async ({ board, caller, item, tools }) => {
      const jubilee = await caller('Jubilee', 'groomer');
      const heldId = await item({ heldBy: jubilee });

      const moved = await tools.call(jubilee, 'transition', {
        record: outcome,
        to: 'build_ready',
      });

      expect(moved).toEqual({
        ok: true,
        value: { id: heldId, state: 'build_ready' },
      });
      expect(await board.listRecords(heldId)).toMatchObject([
        { kind: 'claim' },
        { kind: 'outcome', record: outcome },
      ]);
      expect(await board.getHistory(heldId)).toMatchObject([
        { toState: 'grooming' },
        { actorRole: 'groomer', toState: 'build_ready' },
      ]);
    });
  });

  test('asks the navigator a question and returns the item to its queue after', async () => {
    await withBoard(async ({ board, caller, database, item, tools }) => {
      const jubilee = await caller('Jubilee', 'groomer');
      const heldId = await item({ heldBy: jubilee });

      const waited = await tools.call(jubilee, 'wait_for_navigator', {
        question: 'Is XLSX enough, or ODS too?',
      });

      expect(waited).toEqual({
        ok: true,
        value: { id: heldId, state: 'waiting' },
      });
      expect(await board.getWorkItem(heldId)).toMatchObject({
        state: 'waiting',
      });
      const row = await database
        .selectFrom('work_items')
        .select(['waiting_kind', 'waiting_reason', 'return_state'])
        .where('id', '=', heldId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({
        return_state: 'grooming_ready',
        waiting_kind: 'question',
        waiting_reason: 'Is XLSX enough, or ODS too?',
      });
    });
  });

  describe('refusals', () => {
    test('refuses a tool the type is not allowed', async () => {
      await withBoard(async ({ caller, tools }) => {
        const assistant = await caller('Cerebro', 'assistant');

        expect(
          await tools.call(assistant, 'transition', { to: 'build_ready' }),
        ).toMatchObject({ code: 'tool_not_allowed', ok: false });
      });
    });

    test('refuses a tool that does not exist or is not built yet', async () => {
      await withBoard(async ({ caller, tools }) => {
        const assistant = await caller('Cerebro', 'assistant');

        expect(await tools.call(assistant, 'drop_table', {})).toMatchObject({
          code: 'unknown_tool',
          ok: false,
        });
        expect(await tools.call(assistant, 'record_release', {})).toMatchObject(
          { code: 'unknown_tool', ok: false },
        );
      });
    });

    test('refuses an item of another project', async () => {
      await withBoard(async ({ caller, database, item, tools }) => {
        const jubilee = await caller('Jubilee', 'groomer');
        const elsewhere = await registerTestProject(database);
        const foreignId = await item({ projectId: elsewhere });

        expect(
          await tools.call(jubilee, 'get_item', { item_id: foreignId }),
        ).toMatchObject({ code: 'other_project', ok: false });
        expect(
          await tools.call(jubilee, 'comment', {
            body: 'Hi.',
            item_id: foreignId,
          }),
        ).toMatchObject({ code: 'other_project', ok: false });
      });
    });

    test('refuses an item that does not exist', async () => {
      await withBoard(async ({ caller, tools }) => {
        const jubilee = await caller('Jubilee', 'groomer');

        for (const itemId of [crypto.randomUUID(), 'not-a-uuid']) {
          expect(
            await tools.call(jubilee, 'get_item', { item_id: itemId }),
          ).toMatchObject({ code: 'not_found', ok: false });
        }
      });
    });

    test('refuses to move or wait on an item another run holds', async () => {
      await withBoard(async ({ board, caller, item, tools }) => {
        const jubilee = await caller('Jubilee', 'groomer');
        const heldId = await item();
        const claimed = await board.claim(heldId, 'groomer');
        expect(claimed.ok).toBe(true);

        for (const [name, args] of [
          ['transition', { record: outcome, to: 'build_ready' }],
          ['wait_for_navigator', { question: 'Which?' }],
          ['comment', { body: 'Mine now.' }],
        ] as const) {
          expect(await tools.call(jubilee, name, args)).toMatchObject({
            code: 'nothing_held',
            ok: false,
          });
        }
        expect(await board.getWorkItem(heldId)).toMatchObject({
          state: 'grooming',
        });
      });
    });

    test('refuses a transition the lifecycle does not allow', async () => {
      await withBoard(async ({ board, caller, item, tools }) => {
        const jubilee = await caller('Jubilee', 'groomer');
        const heldId = await item({ heldBy: jubilee });

        const refused = await tools.call(jubilee, 'transition', {
          record: outcome,
          to: 'done',
        });

        expect(refused).toMatchObject({ code: 'refused', ok: false });
        expect(await board.getWorkItem(heldId)).toMatchObject({
          state: 'grooming',
        });
      });
    });

    test('refuses a transition without the record it needs', async () => {
      await withBoard(async ({ board, caller, item, tools }) => {
        const jubilee = await caller('Jubilee', 'groomer');
        const heldId = await item({ heldBy: jubilee });

        expect(
          await tools.call(jubilee, 'transition', { to: 'build_ready' }),
        ).toEqual({
          code: 'refused',
          message:
            'Moving a work item from grooming to build_ready needs an outcome record.',
          ok: false,
        });
        expect(await board.getWorkItem(heldId)).toMatchObject({
          state: 'grooming',
        });
      });
    });

    test('refuses malformed arguments', async () => {
      await withBoard(async ({ caller, tools }) => {
        const jubilee = await caller('Jubilee', 'groomer');

        for (const [name, args] of [
          ['create_item', { title: '  ' }],
          ['create_item', {}],
          ['comment', { body: 7 }],
          ['get_item', {}],
          ['list_items', { state: 'shipped' }],
          ['transition', { to: 'somewhere' }],
          ['transition', { record: 'outcome', to: 'build_ready' }],
          ['wait_for_navigator', { question: '' }],
          ['get_item', null],
        ] as const) {
          expect(await tools.call(jubilee, name, args)).toMatchObject({
            code: 'invalid_arguments',
            ok: false,
          });
        }
      });
    });
  });
});
