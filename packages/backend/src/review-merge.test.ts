import type { Kysely } from 'kysely';
import { describe, expect, test } from 'vitest';

import {
  createBoard,
  livePullRequest,
  recordForHeldItem,
  releaseHeldItem,
  type Board,
} from './board.js';
import type { Database } from './database.js';
import type {
  Forge,
  ForgeChecks,
  ForgePullRequest,
  ForgeReview,
  ForgeReviewComment,
} from './forge.js';
import { loadFirstMessage } from './first-message.js';
import { createNavigatorQueue } from './navigator-queue.js';
import { createMergeWatcher } from './merge-watcher.js';
import { registerTestProject, withTestDatabase } from './test-support.js';

const head = '0123456789abcdef0123456789abcdef01234567';
const pullRequestUrl = 'https://github.com/acme/website/pull/482';

const blockingFinding = {
  severity: 'blocking',
  file: 'src/export.ts',
  line: 4,
  problem: 'The header row is missing.',
};

async function nameRun(
  database: Kysely<Database>,
  runId: string,
  name: string,
): Promise<void> {
  await database
    .updateTable('runs')
    .set({ agent_name: name })
    .where('id', '=', runId)
    .execute();
}

/** Files an item and has Wolverine build it into a pull request waiting for review. */
async function builtItem(
  database: Kysely<Database>,
  options: { readonly maxRounds?: number } = {},
): Promise<{ board: Board; itemId: string; projectId: string }> {
  const board = createBoard(database);
  const projectId = await registerTestProject(database);
  await database
    .updateTable('projects')
    .set({ max_rounds: options.maxRounds ?? 3 })
    .where('id', '=', projectId)
    .execute();
  const itemId = crypto.randomUUID();
  await board.createWorkItem({ id: itemId, projectId, title: 'Export' });
  await board.triage(itemId, 'P2', 'build_ready');
  await build(database, board, itemId);
  return { board, itemId, projectId };
}

async function build(
  database: Kysely<Database>,
  board: Board,
  itemId: string,
): Promise<string> {
  const claimed = await board.claim(itemId, 'builder');
  if (!claimed.ok) throw new Error(claimed.reason);
  const runId = claimed.item.holderRunId ?? '';
  await nameRun(database, runId, 'Wolverine');
  await recordForHeldItem(database, itemId, runId, {
    kind: 'plan',
    markdown: 'plan',
  });
  await recordForHeldItem(database, itemId, runId, {
    kind: 'checks',
    passed: true,
  });
  const handed = await board.transition(itemId, {
    actor: { role: 'builder', runId },
    record: {
      branch: 'WEB-1-export',
      head,
      kind: 'pull_request',
      title: 'Export invoices',
      url: pullRequestUrl,
    },
    to: 'review_ready',
  });
  if (!handed.ok) throw new Error(handed.reason);
  return runId;
}

/** Rogue reviews the item and records `verdict` on `revision`. */
async function review(
  database: Kysely<Database>,
  board: Board,
  itemId: string,
  verdict: 'approved' | 'changes_requested',
  findings: readonly Record<string, unknown>[] = verdict === 'approved'
    ? []
    : [blockingFinding],
  revision = head,
): Promise<void> {
  const claimed = await board.claim(itemId, 'reviewer');
  if (!claimed.ok) throw new Error(claimed.reason);
  const runId = claimed.item.holderRunId ?? '';
  await nameRun(database, runId, 'Rogue');
  const reviewed = await board.transition(itemId, {
    actor: { role: 'reviewer', runId },
    record: {
      findings,
      kind: 'review',
      revision,
      url: `${pullRequestUrl}#pullrequestreview-9`,
      verdict,
    },
    to: verdict === 'approved' ? 'merging' : 'build_ready',
  });
  if (!reviewed.ok) throw new Error(reviewed.reason);
}

describe('review and rework on the board', { concurrent: false }, () => {
  test('a changes request goes back to a builder who continues the same pull request', async () => {
    await withTestDatabase(async (database) => {
      const { board, itemId } = await builtItem(database);
      await review(database, board, itemId, 'changes_requested');

      expect(await livePullRequest(database, itemId)).toEqual({
        branch: 'WEB-1-export',
        head,
        number: 482,
        url: pullRequestUrl,
      });
      const claimed = await board.claim(itemId, 'builder');
      if (!claimed.ok) throw new Error(claimed.reason);
      await nameRun(database, claimed.item.holderRunId ?? '', 'Wolverine');

      const activity = await board.deliveryActivity(itemId);
      expect(activity.events.slice(-2)).toMatchObject([
        {
          agentName: 'Rogue',
          findings: [blockingFinding],
          kind: 'review',
          revision: head,
          url: `${pullRequestUrl}#pullrequestreview-9`,
          verdict: 'changes_requested',
        },
        {
          agentName: 'Wolverine',
          kind: 'rework_started',
          maxRounds: 3,
          round: 2,
        },
      ]);
      expect(activity.blocked).toBeNull();
    });
  });

  test('a first build writes no rework entry', async () => {
    await withTestDatabase(async (database) => {
      const { board, itemId } = await builtItem(database);

      const kinds = (await board.deliveryActivity(itemId)).events.map(
        (event) => event.kind,
      );
      expect(kinds).not.toContain('rework_started');
    });
  });

  test('the changes request that reaches max_rounds blocks the item for the navigator', async () => {
    await withTestDatabase(async (database) => {
      const { board, itemId } = await builtItem(database, { maxRounds: 2 });
      await review(database, board, itemId, 'changes_requested');
      await build(database, board, itemId);
      await review(database, board, itemId, 'changes_requested');

      expect(await board.getWorkItem(itemId)).toMatchObject({
        state: 'waiting',
      });
      const activity = await board.deliveryActivity(itemId);
      expect(activity.blocked).toMatchObject({
        canReturnToDesign: true,
        event: { count: 2, kind: 'blocked', reason: 'too_many_rounds' },
      });
      expect(activity.events.at(-1)).toMatchObject({
        kind: 'blocked',
        reason: 'too_many_rounds',
      });
    });
  });

  test('a builder that runs out of attempts blocks the item as too many attempts', async () => {
    await withTestDatabase(async (database) => {
      const board = createBoard(database);
      const projectId = await registerTestProject(database);
      await database
        .updateTable('projects')
        .set({ max_attempts: 1 })
        .where('id', '=', projectId)
        .execute();
      const itemId = crypto.randomUUID();
      await board.createWorkItem({ id: itemId, projectId, title: 'Export' });
      await board.triage(itemId, 'P2', 'build_ready');
      const claimed = await board.claim(itemId, 'builder');
      if (!claimed.ok) throw new Error(claimed.reason);

      await database.transaction().execute((transaction) =>
        releaseHeldItem(transaction, claimed.item.holderRunId ?? '', {
          lastMessage: null,
          reason: 'The run failed.',
        }),
      );

      const activity = await board.deliveryActivity(itemId);
      expect(activity.blocked).toMatchObject({
        event: { count: 1, kind: 'blocked', reason: 'too_many_attempts' },
      });
      const item = await database
        .selectFrom('work_items')
        .select(['waiting_reason', 'return_state'])
        .where('id', '=', itemId)
        .executeTakeFirstOrThrow();
      expect(item).toEqual({
        return_state: 'build_ready',
        waiting_reason: 'Stopped: too many attempts',
      });
    });
  });

  test('an approved item waits for its checks', async () => {
    await withTestDatabase(async (database) => {
      const { board, itemId } = await builtItem(database);
      await review(database, board, itemId, 'approved');

      const activity = await board.deliveryActivity(itemId);
      expect(activity.current).toEqual({ kind: 'waiting_for_checks' });
      expect(activity.events.at(-1)).toMatchObject({
        agentName: 'Rogue',
        kind: 'review',
        verdict: 'approved',
      });
    });
  });
});

describe('answering a blocked item', { concurrent: false }, () => {
  async function blockedItem(database: Kysely<Database>) {
    const built = await builtItem(database, { maxRounds: 1 });
    await review(database, built.board, built.itemId, 'changes_requested');
    return built;
  }

  test('sending it back returns it to the builder with a trail entry', async () => {
    await withTestDatabase(async (database) => {
      const { board, itemId } = await blockedItem(database);

      expect(await board.sendBack(itemId)).toMatchObject({
        ok: true,
        item: { rounds: 0, state: 'build_ready' },
      });
      const activity = await board.deliveryActivity(itemId);
      expect(activity.blocked).toBeNull();
      expect(activity.events.at(-1)).toMatchObject({ kind: 'sent_back' });
      expect(await board.sendBack(itemId)).toEqual({
        code: 'not_waiting',
        ok: false,
        reason: 'This item is no longer waiting for you.',
      });
    });
  });

  test('returning it to design needs a reason and ends the pull request', async () => {
    await withTestDatabase(async (database) => {
      const { board, itemId } = await blockedItem(database);

      expect(await board.returnToDesign(itemId, '  ')).toEqual({
        code: 'reason_required',
        ok: false,
        reason:
          'Give a reason so the designer and the next builder know what to change.',
      });
      expect(
        await board.returnToDesign(itemId, 'The export needs a new layout.'),
      ).toMatchObject({ ok: true, item: { state: 'design_ready' } });

      const activity = await board.deliveryActivity(itemId);
      expect(activity.blocked).toBeNull();
      expect(activity.events.at(-1)).toMatchObject({
        kind: 'returned_to_design',
        reason: 'The export needs a new layout.',
      });
      expect(await livePullRequest(database, itemId)).toBeNull();
    });
  });

  test('returning to design is unavailable while the design stage is off', async () => {
    await withTestDatabase(async (database) => {
      const { board, itemId, projectId } = await blockedItem(database);
      await database
        .updateTable('projects')
        .set({ design_enabled: false })
        .where('id', '=', projectId)
        .execute();

      expect(
        (await board.deliveryActivity(itemId)).blocked?.canReturnToDesign,
      ).toBe(false);
      expect(await board.returnToDesign(itemId, 'Redo it.')).toMatchObject({
        code: 'route_unavailable',
        ok: false,
      });
    });
  });
});

/** A forge that answers what a test sets and remembers what the backend asked of it. */
function fakeForge(
  answers: {
    checks?: ForgeChecks;
    merge?: Awaited<ReturnType<Forge['merge']>>;
    pullRequest?: Partial<ForgePullRequest>;
    failing?: boolean;
    reviews?: readonly ForgeReview[];
    comments?: readonly ForgeReviewComment[];
  } = {},
) {
  const calls: string[] = [];
  const forge: Forge = {
    async checks(sha) {
      calls.push(`checks ${sha}`);
      return answers.checks ?? { status: 'success' };
    },
    async closePullRequest(number, comment) {
      calls.push(`close ${number} ${comment}`);
      if (answers.failing) throw new Error('GitHub is down');
    },
    async deleteBranch(branch) {
      calls.push(`delete ${branch}`);
    },
    async merge(number, sha) {
      calls.push(`merge ${number} ${sha}`);
      return answers.merge ?? { merged: true };
    },
    async reviewComments(number, reviewId) {
      calls.push(`comments ${number} ${reviewId}`);
      return [...(answers.comments ?? [])];
    },
    async reviews(number) {
      calls.push(`reviews ${number}`);
      if (answers.failing) throw new Error('GitHub is down');
      return [...(answers.reviews ?? [])];
    },
    async pullRequest(number) {
      calls.push(`pull ${number}`);
      if (answers.failing) throw new Error('GitHub is down');
      return {
        branch: 'WEB-1-export',
        head,
        mergeable: true,
        state: 'open',
        ...answers.pullRequest,
      };
    },
  };
  return { calls, forge };
}

async function approvedItem(database: Kysely<Database>) {
  const built = await builtItem(database);
  await review(database, built.board, built.itemId, 'approved');
  return built;
}

describe('the backend merge', { concurrent: false }, () => {
  test('merges the approved revision once every check passed, and deletes the branch', async () => {
    await withTestDatabase(async (database) => {
      const { board, itemId } = await approvedItem(database);
      const { calls, forge } = fakeForge();

      await createMergeWatcher({ database, forge: async () => forge }).pass();

      expect(calls).toEqual([
        'pull 482',
        `checks ${head}`,
        `merge 482 ${head}`,
        'delete WEB-1-export',
      ]);
      expect(await board.getWorkItem(itemId)).toMatchObject({ state: 'done' });
      const activity = await board.deliveryActivity(itemId);
      expect(activity.current).toBeNull();
      expect(activity.events.at(-1)).toMatchObject({
        base: 'main',
        kind: 'merged',
        sha: head,
      });
    });
  });

  test('waits while checks are pending or mergeability is unknown', async () => {
    await withTestDatabase(async (database) => {
      const { board, itemId } = await approvedItem(database);
      for (const answers of [
        { checks: { status: 'pending' } as const },
        { pullRequest: { mergeable: null } },
      ]) {
        const { calls, forge } = fakeForge(answers);
        await createMergeWatcher({ database, forge: async () => forge }).pass();
        expect(calls.some((call) => call.startsWith('merge'))).toBe(false);
      }
      expect(await board.getWorkItem(itemId)).toMatchObject({
        state: 'merging',
      });
    });
  });

  test.each([
    [
      'a required check failed',
      { checks: { check: 'test (ubuntu)', status: 'failure' } as const },
      {
        check: 'test (ubuntu)',
        reason: 'check_failed',
        reviewer: 'Rogue',
        revision: head,
      },
      "Can't merge: a required check failed",
    ],
    [
      'the branch conflicts',
      { pullRequest: { mergeable: false } },
      { base: 'main', reason: 'conflict' },
      "Can't merge: the branch conflicts with main",
    ],
    [
      'new commits arrived after the approval',
      { pullRequest: { head: 'fedcba9876543210fedcba9876543210fedcba98' } },
      { reason: 'changed_since_approval', reviewer: 'Rogue', revision: head },
      "Can't merge: changed since approval",
    ],
    [
      'the head moved as the merge was made',
      { merge: { merged: false, reason: 'head_moved' } as const },
      { reason: 'changed_since_approval', revision: head },
      "Can't merge: changed since approval",
    ],
    [
      'GitHub refuses the merge',
      {
        merge: {
          merged: false,
          message: 'At least 1 approving review is required.',
          reason: 'refused',
        } as const,
      },
      {
        message: 'At least 1 approving review is required.',
        reason: 'refused',
      },
      "Can't merge: GitHub refused the merge",
    ],
    [
      'someone closed the pull request without merging it',
      { pullRequest: { state: 'closed' as const } },
      {
        message: 'Pull request #482 was closed without merging.',
        reason: 'refused',
      },
      "Can't merge: GitHub refused the merge",
    ],
  ])(
    'nothing merges when %s: it waits for the navigator',
    async (_name, answers, detail, heading) => {
      await withTestDatabase(async (database) => {
        const { board, itemId } = await approvedItem(database);
        const { forge } = fakeForge(answers);

        await createMergeWatcher({ database, forge: async () => forge }).pass();

        const item = await database
          .selectFrom('work_items')
          .select(['state', 'waiting_kind', 'waiting_reason', 'return_state'])
          .where('id', '=', itemId)
          .executeTakeFirstOrThrow();
        expect(item).toEqual({
          return_state: 'merging',
          state: 'waiting',
          waiting_kind: 'escalation',
          waiting_reason: heading,
        });
        expect((await board.deliveryActivity(itemId)).blocked).toMatchObject({
          event: { kind: 'blocked', ...detail },
        });
      });
    },
  );

  test('a revision nothing checks merges once checks have had time to start', async () => {
    await withTestDatabase(async (database) => {
      const { board, itemId } = await approvedItem(database);
      const { calls, forge } = fakeForge({ checks: { status: 'none' } });

      await createMergeWatcher({ database, forge: async () => forge }).pass();
      expect(calls.some((call) => call.startsWith('merge'))).toBe(false);
      expect(await board.getWorkItem(itemId)).toMatchObject({
        state: 'merging',
      });

      await createMergeWatcher({
        database,
        forge: async () => forge,
        now: () => new Date(Date.now() + 6 * 60_000),
      }).pass();
      expect(calls).toContain(`merge 482 ${head}`);
      expect(await board.getWorkItem(itemId)).toMatchObject({ state: 'done' });
    });
  });

  test('a pull request someone else merged completes the item', async () => {
    await withTestDatabase(async (database) => {
      const { board, itemId } = await approvedItem(database);
      const { calls, forge } = fakeForge({ pullRequest: { state: 'merged' } });

      await createMergeWatcher({ database, forge: async () => forge }).pass();

      expect(calls).not.toContain(`merge 482 ${head}`);
      expect(await board.getWorkItem(itemId)).toMatchObject({ state: 'done' });
    });
  });

  test('an unreachable forge leaves the item merging', async () => {
    await withTestDatabase(async (database) => {
      const { board, itemId } = await approvedItem(database);
      const { forge } = fakeForge({ failing: true });

      await createMergeWatcher({
        database,
        forge: async () => forge,
        log: () => {},
      }).pass();

      expect(await board.getWorkItem(itemId)).toMatchObject({
        state: 'merging',
      });
    });
  });

  test('closes the pull request of an item returned to design, until it succeeds', async () => {
    await withTestDatabase(async (database) => {
      const { board, itemId } = await builtItem(database, { maxRounds: 1 });
      await review(database, board, itemId, 'changes_requested');
      await board.returnToDesign(itemId, 'The export needs a new layout.');

      const down = fakeForge({ failing: true });
      await createMergeWatcher({
        database,
        forge: async () => down.forge,
        log: () => {},
      }).pass();
      const up = fakeForge();
      await createMergeWatcher({
        database,
        forge: async () => up.forge,
      }).pass();
      await createMergeWatcher({
        database,
        forge: async () => up.forge,
      }).pass();

      expect(up.calls).toEqual([
        'pull 482',
        'close 482 Returned to design: The export needs a new layout.',
        'delete WEB-1-export',
      ]);
    });
  });

  test('a close retried after the pull request closed does not comment again', async () => {
    await withTestDatabase(async (database) => {
      const { board, itemId } = await builtItem(database, { maxRounds: 1 });
      await review(database, board, itemId, 'changes_requested');
      await board.returnToDesign(itemId, 'The export needs a new layout.');
      const { calls, forge } = fakeForge({ pullRequest: { state: 'closed' } });

      await createMergeWatcher({ database, forge: async () => forge }).pass();

      expect(calls).toEqual(['pull 482', 'delete WEB-1-export']);
    });
  });
});

describe(
  'the navigator’s own review on GitHub (spec §4.9)',
  { concurrent: false },
  () => {
    async function waitingForCode(
      database: Kysely<Database>,
      options: { readonly maxRounds?: number } = {},
    ) {
      const built = await builtItem(database, options);
      await database
        .updateTable('projects')
        .set({ involvement: 'full', review_account: 'octocat' })
        .where('id', '=', built.projectId)
        .execute();
      await review(database, built.board, built.itemId, 'approved');
      return built;
    }

    async function row(database: Kysely<Database>, itemId: string) {
      return database
        .selectFrom('work_items')
        .select([
          'state',
          'rounds',
          'return_state',
          'waiting_kind',
          'waiting_reason',
        ])
        .where('id', '=', itemId)
        .executeTakeFirstOrThrow();
    }

    function submitted(
      login: string,
      state: ForgeReview['state'],
      id: number,
      options: { readonly body?: string; readonly at?: Date } = {},
    ): ForgeReview {
      return {
        body: options.body ?? '',
        id,
        login,
        state,
        submittedAt: options.at ?? new Date(Date.now() + 1_000),
        url: `${pullRequestUrl}#pullrequestreview-${id}`,
      };
    }

    test('the reviewer’s approval waits for the navigator’s review, shown on the item and in the queue', async () => {
      await withTestDatabase(async (database) => {
        const { board, itemId } = await waitingForCode(database);
        const { calls, forge } = fakeForge();

        await createMergeWatcher({ database, forge: async () => forge }).pass();

        expect(calls).toEqual(['reviews 482']);
        expect(await row(database, itemId)).toMatchObject({
          return_state: 'merging',
          state: 'waiting',
          waiting_kind: 'code_review',
          waiting_reason: 'Waiting for your review on GitHub',
        });
        const activity = await board.deliveryActivity(itemId);
        expect(activity.current).toEqual({
          account: 'octocat',
          kind: 'code_review',
          pullRequestUrl,
          reviewer: 'Rogue',
        });
        expect(activity.blocked).toBeNull();
        expect(
          (await createNavigatorQueue(database).list()).entries,
        ).toMatchObject([
          { checkpoint: 'code_review', id: itemId, kind: 'review' },
        ]);
      });
    });

    test('an approval from the configured account moves it on to merge', async () => {
      await withTestDatabase(async (database) => {
        const { board, itemId } = await waitingForCode(database);
        const { calls, forge } = fakeForge({
          reviews: [
            submitted('octocat', 'commented', 1),
            submitted('OctoCat', 'approved', 2),
          ],
        });

        await createMergeWatcher({ database, forge: async () => forge }).pass();

        expect(await board.getWorkItem(itemId)).toMatchObject({
          state: 'done',
        });
        expect(calls).toContain(`merge 482 ${head}`);
        const kinds = (await board.deliveryActivity(itemId)).events.map(
          (event) => event.kind,
        );
        expect(kinds.slice(-3)).toEqual([
          'review',
          'navigator_review',
          'merged',
        ]);
        expect(
          (await board.deliveryActivity(itemId)).events.find(
            (event) => event.kind === 'navigator_review',
          ),
        ).toMatchObject({
          comments: [],
          url: `${pullRequestUrl}#pullrequestreview-2`,
          verdict: 'approved',
        });
      });
    });

    test('requested changes send it back to the builder with the review’s comments, as a round', async () => {
      await withTestDatabase(async (database) => {
        const { board, itemId } = await waitingForCode(database);
        const comments = [
          {
            body: 'Name the file after the month.',
            file: 'src/export.ts',
            line: 12,
          },
        ];
        const { forge } = fakeForge({
          comments,
          reviews: [
            submitted('octocat', 'changes_requested', 5, {
              body: 'Nearly there.',
            }),
          ],
        });

        await createMergeWatcher({ database, forge: async () => forge }).pass();

        expect(await row(database, itemId)).toMatchObject({
          rounds: 1,
          state: 'build_ready',
        });
        const claimed = await board.claim(itemId, 'builder');
        if (!claimed.ok) throw new Error(claimed.reason);
        await nameRun(database, claimed.item.holderRunId ?? '', 'Wolverine');
        const events = (await board.deliveryActivity(itemId)).events;
        expect(events.slice(-2)).toMatchObject([
          {
            body: 'Nearly there.',
            comments,
            kind: 'navigator_review',
            url: `${pullRequestUrl}#pullrequestreview-5`,
            verdict: 'changes_requested',
          },
          { kind: 'rework_started', maxRounds: 3, round: 2 },
        ]);
        const message = await loadFirstMessage(database, itemId, 'builder');
        expect(message).toContain(
          'The navigator requested changes on GitHub: “Nearly there.”',
        );
        expect(message).toContain(
          '- src/export.ts:12 — Name the file after the month.',
        );
      });
    });

    test('requested changes that reach max_rounds block the item', async () => {
      await withTestDatabase(async (database) => {
        const { itemId } = await waitingForCode(database, {
          maxRounds: 1,
        });
        const { forge } = fakeForge({
          reviews: [submitted('octocat', 'changes_requested', 5)],
        });

        await createMergeWatcher({ database, forge: async () => forge }).pass();

        expect(await row(database, itemId)).toMatchObject({
          state: 'waiting',
          waiting_kind: 'escalation',
          waiting_reason: "Can't merge: too many rounds",
        });
      });
    });

    test('a review from any other account never counts, and is noted once', async () => {
      await withTestDatabase(async (database) => {
        const { board, itemId } = await waitingForCode(database);
        const { forge } = fakeForge({
          reviews: [
            submitted('hubot', 'approved', 7),
            submitted('hubot', 'changes_requested', 8),
            submitted('octocat', 'approved', 9, { at: new Date(0) }),
          ],
        });
        const watcher = createMergeWatcher({
          database,
          forge: async () => forge,
        });

        await watcher.pass();
        await watcher.pass();

        expect(await row(database, itemId)).toMatchObject({
          state: 'waiting',
          waiting_kind: 'code_review',
        });
        const noted = (await board.deliveryActivity(itemId)).events.filter(
          (event) => event.kind === 'review_not_counted',
        );
        expect(noted).toEqual([
          expect.objectContaining({
            account: 'octocat',
            kind: 'review_not_counted',
            login: 'hubot',
          }),
        ]);
      });
    });

    test('a later change of account leaves the waiting review as it was', async () => {
      await withTestDatabase(async (database) => {
        const { board, itemId, projectId } = await waitingForCode(database);
        await database
          .updateTable('projects')
          .set({ involvement: 'autonomous', review_account: null })
          .where('id', '=', projectId)
          .execute();
        const { forge } = fakeForge({
          reviews: [submitted('octocat', 'approved', 3)],
        });

        await createMergeWatcher({ database, forge: async () => forge }).pass();

        expect(await board.getWorkItem(itemId)).toMatchObject({
          state: 'done',
        });
      });
    });
  },
);
