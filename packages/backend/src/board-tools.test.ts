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
import { createPlanApprovals, type PlanApprovals } from './plan-approvals.js';
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

const outcomeQuestion = (body = outcome.markdown) => ({
  header: 'Outcome',
  multiSelect: false,
  options: [
    {
      description: 'agree what people will see first',
      label: 'Design next',
    },
    {
      description: 'nothing new to see; go straight to building',
      label: 'Build next (Recommended)',
    },
  ],
  question: `Confirm the outcome and where it goes next\n\n${body.split('\n## Route')[0] ?? ''}`,
});

interface Fixture {
  readonly board: Board;
  /** What the backend wrote into runs' conversations, in order. */
  readonly notes: { runId: string; event: unknown; state: string }[];
  readonly plans: PlanApprovals;
  /** Runs whose tool call gave up their held item, in order. */
  readonly released: string[];
  readonly database: Kysely<Database>;
  readonly projectId: string;
  readonly tools: ReturnType<typeof createBoardTools>;
  caller(name: string, role: RunRole, projectId?: string): Promise<ToolCaller>;
  /** Records the outcome question in the run's events, and the navigator's answer if given. */
  ask(
    caller: ToolCaller,
    options?: { readonly answer?: string; readonly markdown?: string },
  ): Promise<void>;
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
    const released: string[] = [];
    const notes: Fixture['notes'] = [];
    const plans = createPlanApprovals({
      database,
      note: async (runId, event, state) => {
        notes.push({ event, runId, state });
        await runs.append(runId, event);
      },
    });
    await run({
      board,
      database,
      notes,
      plans,
      projectId,
      released,
      tools: createBoardTools({
        board,
        database,
        onReleased: (runId) => released.push(runId),
        plans,
      }),
      async ask(caller, { answer, markdown } = {}) {
        const question = outcomeQuestion(markdown);
        const questionId = crypto.randomUUID();
        await runs.append(caller.runId, {
          kind: 'question',
          questionId,
          questions: [question],
        });
        if (answer !== undefined) {
          await runs.append(caller.runId, {
            answers: { [question.question]: answer },
            kind: 'answer',
            questionId,
          });
        }
      },
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
    await withBoard(async ({ ask, board, caller, item, tools }) => {
      const jubilee = await caller('Jubilee', 'groomer');
      const heldId = await item({ heldBy: jubilee });
      await ask(jubilee, { answer: 'Build next (Recommended)' });

      const moved = await tools.call(jubilee, 'transition', {
        record: outcome,
        to: 'build_ready',
      });

      expect(moved).toEqual({
        ok: true,
        value: {
          id: heldId,
          message: 'Recorded. Export as XLSX now waits for build.',
          state: 'build_ready',
        },
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

  test('reads the held item when get_item names none', async () => {
    await withBoard(async ({ caller, item, tools }) => {
      const jubilee = await caller('Jubilee', 'groomer');
      const heldId = await item({ heldBy: jubilee, title: 'Export invoices' });
      const idle = await caller('Cerebro', 'assistant');

      expect(await tools.call(jubilee, 'get_item', {})).toMatchObject({
        ok: true,
        value: { item: { id: heldId, title: 'Export invoices' } },
      });
      expect(await tools.call(idle, 'get_item', {})).toMatchObject({
        code: 'nothing_held',
        ok: false,
      });
    });
  });

  test('reports a run whose call gave up its item, and no other', async () => {
    await withBoard(async ({ ask, caller, item, released, tools }) => {
      const jubilee = await caller('Jubilee', 'groomer');
      await item({ heldBy: jubilee });
      await tools.call(jubilee, 'comment', { body: 'Reading.' });
      await tools.call(jubilee, 'transition', { to: 'done' });
      expect(released).toEqual([]);

      await ask(jubilee, { answer: 'Build next' });
      await tools.call(jubilee, 'transition', {
        record: outcome,
        to: 'build_ready',
      });
      await item({ heldBy: jubilee });
      await tools.call(jubilee, 'wait_for_navigator', { question: 'Which?' });

      expect(released).toEqual([jubilee.runId, jubilee.runId]);
    });
  });

  describe('leaving grooming on the confirmed route', () => {
    test('refuses before the navigator was asked, or before they answered', async () => {
      await withBoard(async ({ ask, board, caller, item, tools }) => {
        const jubilee = await caller('Jubilee', 'groomer');
        const heldId = await item({ heldBy: jubilee });
        const move = () =>
          tools.call(jubilee, 'transition', {
            record: outcome,
            to: 'build_ready',
          });

        expect(await move()).toMatchObject({
          code: 'refused',
          message: expect.stringContaining('Ask the navigator') as unknown,
          ok: false,
        });
        await ask(jubilee);
        expect(await move()).toMatchObject({
          code: 'refused',
          message: expect.stringContaining('not answered') as unknown,
          ok: false,
        });
        expect(await board.getWorkItem(heldId)).toMatchObject({
          state: 'grooming',
        });
        expect(await board.listRecords(heldId)).toMatchObject([
          { kind: 'claim' },
        ]);
      });
    });

    test('refuses a route other than the one the navigator chose', async () => {
      await withBoard(async ({ ask, board, caller, item, tools }) => {
        const jubilee = await caller('Jubilee', 'groomer');
        const heldId = await item({ heldBy: jubilee });
        await ask(jubilee, { answer: 'Design next' });

        expect(
          await tools.call(jubilee, 'transition', {
            record: outcome,
            to: 'build_ready',
          }),
        ).toMatchObject({
          code: 'refused',
          message: expect.stringContaining('design_ready') as unknown,
          ok: false,
        });
        expect(await board.getWorkItem(heldId)).toMatchObject({
          state: 'grooming',
        });
      });
    });

    test('refuses when the navigator answered with a change instead of a route', async () => {
      await withBoard(async ({ ask, caller, item, tools }) => {
        const jubilee = await caller('Jubilee', 'groomer');
        await item({ heldBy: jubilee });
        await ask(jubilee, { answer: 'Make it ODS as well.' });

        expect(
          await tools.call(jubilee, 'transition', {
            record: outcome,
            to: 'build_ready',
          }),
        ).toMatchObject({
          code: 'refused',
          message: expect.stringContaining(
            'Updated. Here it is again.',
          ) as unknown,
          ok: false,
        });
      });
    });

    test('refuses an outcome other than the one the navigator confirmed', async () => {
      await withBoard(async ({ ask, caller, item, tools }) => {
        const jubilee = await caller('Jubilee', 'groomer');
        await item({ heldBy: jubilee });
        await ask(jubilee, { answer: 'Build next' });

        expect(
          await tools.call(jubilee, 'transition', {
            record: {
              ...outcome,
              markdown: outcome.markdown.replace('XLSX', 'ODS'),
            },
            to: 'build_ready',
          }),
        ).toMatchObject({
          code: 'refused',
          message: expect.stringContaining('confirmed') as unknown,
          ok: false,
        });
      });
    });

    test('moves on the newest confirmation, to design as well as to build', async () => {
      await withBoard(async ({ ask, board, caller, item, tools }) => {
        const jubilee = await caller('Jubilee', 'groomer');
        const heldId = await item({
          heldBy: jubilee,
          title: 'Export invoices as CSV',
        });
        await ask(jubilee, {
          answer: 'Also credit notes.',
          markdown: outcome.markdown.replace('XLSX', 'ODS'),
        });
        await ask(jubilee, { answer: 'Design next' });

        expect(
          await tools.call(jubilee, 'transition', {
            record: {
              ...outcome,
              markdown: outcome.markdown.replace(
                '## Route\nbuild',
                '## Route\ndesign',
              ),
            },
            to: 'design_ready',
          }),
        ).toEqual({
          ok: true,
          value: {
            id: heldId,
            message: 'Recorded. Export invoices as CSV now waits for design.',
            state: 'design_ready',
          },
        });
        expect(await board.getWorkItem(heldId)).toMatchObject({
          state: 'design_ready',
        });
      });
    });
  });

  describe('building and handing over to review', () => {
    const plan = [
      'Context',
      'Files to change, and what to reuse',
      'Increments',
      'The test plan',
      'User-facing decisions',
      'Out of scope',
      'Validation',
      'Known traps',
    ]
      .map((heading) => `## ${heading}\n\nNone.\n`)
      .join('\n');
    const pullRequest = (change: object = {}) => ({
      branch: 'WEB-1-export-xlsx',
      head: '0123456789abcdef0123456789abcdef01234567',
      kind: 'pull_request',
      title: 'Export as XLSX',
      url: 'https://github.com/acme/website/pull/482',
      ...change,
    });

    async function building(
      board: Board,
      item: Fixture['item'],
      builder: ToolCaller,
    ): Promise<string> {
      const id = await item({ state: 'build_ready' });
      const claimed = await board.transition(id, {
        actor: { role: 'backend', runId: builder.runId },
        record: { kind: 'claim', role: 'builder' },
        to: 'building',
      });
      if (!claimed.ok) throw new Error(claimed.reason);
      return id;
    }

    test('records the plan and checks, then opens the linked pull request', async () => {
      await withBoard(async ({ board, caller, item, released, tools }) => {
        const wolverine = await caller('Storm', 'builder');
        const heldId = await building(board, item, wolverine);

        expect(
          await tools.call(wolverine, 'submit_plan', { markdown: plan }),
        ).toEqual({ ok: true, value: { id: heldId, recorded: 'plan' } });
        expect(
          await tools.call(wolverine, 'report_checks', {
            passed: true,
            summary: 'pnpm run check passed.',
          }),
        ).toEqual({ ok: true, value: { id: heldId, recorded: 'checks' } });
        expect(
          await tools.call(wolverine, 'transition', {
            record: pullRequest(),
            to: 'review_ready',
          }),
        ).toEqual({ ok: true, value: { id: heldId, state: 'review_ready' } });

        expect(await board.listRecords(heldId)).toMatchObject([
          { kind: 'claim' },
          { kind: 'plan', record: { kind: 'plan', markdown: plan } },
          {
            kind: 'checks',
            record: { passed: true, summary: 'pnpm run check passed.' },
          },
          { kind: 'pull_request', record: pullRequest() },
        ]);
        expect(released).toEqual([wolverine.runId]);
      });
    });

    test('refuses a plan without its headings, or from a run that is not building', async () => {
      await withBoard(async ({ board, caller, item, tools }) => {
        const wolverine = await caller('Storm', 'builder');
        const jubilee = await caller('Jubilee', 'groomer');
        await item({ heldBy: jubilee });

        expect(
          await tools.call(wolverine, 'submit_plan', { markdown: plan }),
        ).toMatchObject({ code: 'nothing_held', ok: false });
        const heldId = await building(board, item, wolverine);
        expect(
          await tools.call(wolverine, 'submit_plan', {
            markdown: '## Context\n\nWhy.',
          }),
        ).toEqual({
          code: 'invalid_arguments',
          message:
            'The plan record is missing its "## Files to change, and what to reuse" section.',
          ok: false,
        });
        expect(
          await tools.call(wolverine, 'report_checks', { passed: 'yes' }),
        ).toMatchObject({ code: 'invalid_arguments', ok: false });
        expect(
          await tools.call(jubilee, 'submit_plan', { markdown: plan }),
        ).toMatchObject({ code: 'tool_not_allowed', ok: false });
        expect(
          await tools.call(jubilee, 'report_checks', { passed: true }),
        ).toMatchObject({ code: 'tool_not_allowed', ok: false });
        expect(await board.listRecords(heldId)).toMatchObject([
          { kind: 'claim' },
        ]);
      });
    });

    test('refuses to hand over before a plan and passing checks', async () => {
      await withBoard(async ({ board, caller, item, tools }) => {
        const wolverine = await caller('Storm', 'builder');
        const heldId = await building(board, item, wolverine);
        const handOver = () =>
          tools.call(wolverine, 'transition', {
            record: pullRequest(),
            to: 'review_ready',
          });

        expect(await handOver()).toMatchObject({
          code: 'refused',
          message: expect.stringContaining('submit_plan'),
        });
        await tools.call(wolverine, 'submit_plan', { markdown: plan });
        await tools.call(wolverine, 'report_checks', {
          passed: false,
          summary: 'Two tests fail.',
        });
        expect(await handOver()).toMatchObject({
          code: 'refused',
          message: expect.stringContaining('The latest checks failed'),
        });
        expect(await board.getWorkItem(heldId)).toMatchObject({
          state: 'building',
        });
      });
    });

    test.each([
      [{ branch: 'export-xlsx' }, 'The branch must be named after WEB-1'],
      [{ branch: 'WEB-10-export' }, 'The branch must be named after WEB-1'],
      [
        { url: 'https://github.com/other/website/pull/482' },
        'The pull request must be in acme/website',
      ],
      [
        { url: 'http://github.com/acme/website/pull/482' },
        'The pull_request record has no valid url.',
      ],
      [
        { url: 'https://github.com/acme/website/pull/482/files' },
        'The pull_request record has no valid url.',
      ],
      [
        { url: 'https://gitlab.com/acme/website/-/merge_requests/482' },
        'The pull_request record has no valid url.',
      ],
    ])('refuses a pull request record with %o', async (change, message) => {
      await withBoard(async ({ board, caller, item, tools }) => {
        const wolverine = await caller('Storm', 'builder');
        const heldId = await building(board, item, wolverine);
        await tools.call(wolverine, 'submit_plan', { markdown: plan });
        await tools.call(wolverine, 'report_checks', { passed: true });

        expect(
          await tools.call(wolverine, 'transition', {
            record: pullRequest(change),
            to: 'review_ready',
          }),
        ).toMatchObject({
          code: 'refused',
          message: expect.stringContaining(message),
          ok: false,
        });
        expect(await board.getWorkItem(heldId)).toMatchObject({
          state: 'building',
        });
      });
    });

    test('refuses a pull request when the project names no GitHub repository', async () => {
      await withBoard(async ({ board, caller, database, item, tools }) => {
        const wolverine = await caller('Storm', 'builder');
        const heldId = await building(board, item, wolverine);
        await tools.call(wolverine, 'submit_plan', { markdown: plan });
        await tools.call(wolverine, 'report_checks', { passed: true });
        await database
          .updateTable('projects')
          .set({ remote: 'https://example.com/acme/website.git' })
          .execute();

        expect(
          await tools.call(wolverine, 'transition', {
            record: pullRequest(),
            to: 'review_ready',
          }),
        ).toMatchObject({
          code: 'refused',
          message: expect.stringContaining(
            "This project's repository is not on GitHub",
          ),
          ok: false,
        });
        expect(await board.getWorkItem(heldId)).toMatchObject({
          state: 'building',
        });
      });
    });

    test('accepts a branch named exactly after the item', async () => {
      await withBoard(async ({ board, caller, item, tools }) => {
        const wolverine = await caller('Storm', 'builder');
        await building(board, item, wolverine);
        await tools.call(wolverine, 'submit_plan', { markdown: plan });
        await tools.call(wolverine, 'report_checks', { passed: true });

        expect(
          await tools.call(wolverine, 'transition', {
            record: pullRequest({ branch: 'web-1', title: undefined }),
            to: 'review_ready',
          }),
        ).toMatchObject({ ok: true, value: { state: 'review_ready' } });
      });
    });

    describe('when the navigator approves plans (spec §4.9)', () => {
      async function approvePlans(
        database: Kysely<Database>,
        projectId: string,
      ) {
        await database
          .updateTable('projects')
          .set({ involvement: 'plan' })
          .where('id', '=', projectId)
          .execute();
      }

      async function shown(notes: Fixture['notes'], count: number) {
        await expect
          .poll(
            () =>
              notes.filter(
                (note) =>
                  (note.event as { kind: string }).kind === 'plan_approval',
              ).length,
          )
          .toBe(count);
        const plans = notes.filter(
          (note) => (note.event as { kind: string }).kind === 'plan_approval',
        );
        return (plans.at(-1)?.event as { planId: number }).planId;
      }

      test('waits for the navigator, returns what should change, then the approval', async () => {
        await withBoard(
          async ({
            board,
            caller,
            database,
            item,
            notes,
            plans,
            projectId,
            tools,
          }) => {
            await approvePlans(database, projectId);
            const wolverine = await caller('Storm', 'builder');
            const heldId = await building(board, item, wolverine);

            const first = tools.call(wolverine, 'submit_plan', {
              markdown: plan,
            });
            const firstId = await shown(notes, 1);
            expect(notes[0]).toEqual({
              event: { kind: 'plan_approval', markdown: plan, planId: firstId },
              runId: wolverine.runId,
              state: 'awaiting_input',
            });
            await tools.call(wolverine, 'report_checks', { passed: true });
            expect(
              await tools.call(wolverine, 'transition', {
                record: pullRequest(),
                to: 'review_ready',
              }),
            ).toMatchObject({
              code: 'refused',
              message: expect.stringContaining(
                'The navigator has not approved the latest plan',
              ),
            });

            await expect(
              plans.answer(wolverine.runId, {
                planId: firstId,
                text: '  ',
                verdict: 'changes',
              }),
            ).rejects.toThrow(
              'Say what should change so the builder can revise the plan.',
            );
            await plans.answer(wolverine.runId, {
              planId: firstId,
              text: 'Also handle the empty board.',
              verdict: 'changes',
            });
            expect(await first).toEqual({
              ok: true,
              value: {
                approved: false,
                changes: 'Also handle the empty board.',
                id: heldId,
                message:
                  'The navigator asked for changes to the plan: Also handle the empty board. Revise the plan and submit it again with submit_plan before writing code.',
                recorded: 'plan',
              },
            });
            expect(notes[1]).toEqual({
              event: {
                kind: 'plan_answer',
                planId: firstId,
                text: 'Also handle the empty board.',
                verdict: 'changes',
              },
              runId: wolverine.runId,
              state: 'active',
            });

            const second = tools.call(wolverine, 'submit_plan', {
              markdown: plan,
            });
            const secondId = await shown(notes, 2);
            await expect(
              plans.answer(wolverine.runId, {
                planId: firstId,
                text: '',
                verdict: 'approved',
              }),
            ).rejects.toThrow('This plan is no longer waiting for you.');
            await plans.answer(wolverine.runId, {
              planId: secondId,
              text: 'ignored',
              verdict: 'approved',
            });
            expect(await second).toEqual({
              ok: true,
              value: {
                approved: true,
                id: heldId,
                message: 'The navigator approved the plan. Build it.',
                recorded: 'plan',
              },
            });
            await expect(
              plans.answer(wolverine.runId, {
                planId: secondId,
                text: '',
                verdict: 'approved',
              }),
            ).rejects.toThrow('This plan is no longer waiting for you.');

            expect(
              await tools.call(wolverine, 'transition', {
                record: pullRequest(),
                to: 'review_ready',
              }),
            ).toMatchObject({ ok: true, value: { state: 'review_ready' } });
            expect(await board.listRecords(heldId)).toMatchObject([
              { kind: 'claim' },
              { kind: 'plan', record: { approval: 'required' } },
              { kind: 'checks' },
              {
                kind: 'plan_answer',
                record: { planId: firstId, verdict: 'changes' },
              },
              { kind: 'plan', record: { approval: 'required' } },
              {
                kind: 'plan_answer',
                record: { planId: secondId, text: '', verdict: 'approved' },
              },
              { kind: 'pull_request' },
            ]);
          },
        );
      });

      test('stops waiting when the call is abandoned', async () => {
        await withBoard(
          async ({
            board,
            caller,
            database,
            item,
            notes,
            projectId,
            tools,
          }) => {
            await approvePlans(database, projectId);
            const wolverine = await caller('Storm', 'builder');
            await building(board, item, wolverine);
            const abandon = new AbortController();

            const call = tools.call(
              wolverine,
              'submit_plan',
              { markdown: plan },
              abandon.signal,
            );
            await shown(notes, 1);
            abandon.abort(new Error('The runner hung up.'));

            await expect(call).rejects.toThrow('The runner hung up.');
          },
        );
      });

      test('refuses an answer for a run that holds nothing or does not exist', async () => {
        await withBoard(async ({ caller, plans }) => {
          const wolverine = await caller('Storm', 'builder');

          await expect(
            plans.answer(wolverine.runId, { planId: 1, verdict: 'approved' }),
          ).rejects.toMatchObject({ code: 'not_waiting' });
          await expect(
            plans.answer(crypto.randomUUID(), {
              planId: 1,
              verdict: 'approved',
            }),
          ).rejects.toMatchObject({ code: 'not_found' });
          await expect(
            plans.answer(wolverine.runId, { planId: 'x', verdict: 'approved' }),
          ).rejects.toMatchObject({ code: 'invalid' });
        });
      });

      test('records the plan without waiting under Autonomous', async () => {
        await withBoard(async ({ board, caller, item, notes, tools }) => {
          const wolverine = await caller('Storm', 'builder');
          const heldId = await building(board, item, wolverine);

          expect(
            await tools.call(wolverine, 'submit_plan', { markdown: plan }),
          ).toEqual({ ok: true, value: { id: heldId, recorded: 'plan' } });
          expect(notes).toEqual([]);
          expect(await board.listRecords(heldId)).toMatchObject([
            { kind: 'claim' },
            { kind: 'plan', record: { approval: 'none' } },
          ]);
        });
      });
    });
  });

  test('files an item as the type it names, a feature by default', async () => {
    await withBoard(async ({ board, caller, tools }) => {
      const wolverine = await caller('Storm', 'builder');

      const bug = await tools.call(wolverine, 'create_item', {
        title: 'Crash on empty export',
        type: 'bug',
      });
      const feature = await tools.call(wolverine, 'create_item', {
        title: 'Export as ODS',
      });

      expect(
        await board.getWorkItem((bug as { value: { id: string } }).value.id),
      ).toMatchObject({ type: 'bug' });
      expect(
        await board.getWorkItem(
          (feature as { value: { id: string } }).value.id,
        ),
      ).toMatchObject({ type: 'feature' });
      expect(
        await tools.call(wolverine, 'create_item', {
          title: 'Chore',
          type: 'chore',
        }),
      ).toMatchObject({ code: 'invalid_arguments', ok: false });
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

    test('refuses a record the move does not take, so none can be forged', async () => {
      await withBoard(async ({ board, caller, item, tools }) => {
        const jubilee = await caller('Jubilee', 'groomer');
        const heldId = await item({ heldBy: jubilee });

        expect(
          await tools.call(jubilee, 'transition', {
            reason: 'Duplicate.',
            record: { kind: 'claim', role: 'navigator' },
            to: 'cancelled',
          }),
        ).toMatchObject({ code: 'refused', ok: false });
        expect(await board.listRecords(heldId)).toMatchObject([
          { kind: 'claim', record: { role: 'groomer' } },
        ]);
      });
    });

    test('refuses malformed arguments', async () => {
      await withBoard(async ({ caller, tools }) => {
        const jubilee = await caller('Jubilee', 'groomer');

        for (const [name, args] of [
          ['create_item', { title: '  ' }],
          ['create_item', {}],
          ['comment', { body: 7 }],
          ['get_item', { item_id: 7 }],
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
