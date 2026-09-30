import type { Kysely } from 'kysely';

import {
  blockedHeading,
  livePullRequest,
  transitionLocked,
  type BlockedDetail,
  type LivePullRequest,
} from './board.js';
import type { Database } from './database.js';
import type { Forge, ForgeReview, ProjectForge } from './forge.js';

export interface MergeWatcher {
  /** Nudges a pass soon; passes never overlap. */
  nudge(): void;
  /** Looks once at every approved item and every pull request still to close. */
  pass(): Promise<void>;
}

/**
 * The backend's merge (spec §4.4, architecture §8): an approved item merges only its approved
 * revision, only once every check on it passed and it merges cleanly. Anything else stops it for
 * the navigator with the reason; a forge that cannot be reached leaves it to the next pass.
 */
export function createMergeWatcher(options: {
  readonly database: Kysely<Database>;
  readonly forge: ProjectForge;
  readonly log?: (message: string) => void;
  readonly now?: () => Date;
}): MergeWatcher {
  const { database } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((message) => console.error(message));
  let running: Promise<void> | null = null;
  let again = false;

  const watchMerging = async () => {
    const items = await database
      .selectFrom('work_items')
      .innerJoin('projects', 'projects.id', 'work_items.project_id')
      .select([
        'work_items.id',
        'work_items.project_id',
        'projects.default_branch',
      ])
      .where('work_items.state', '=', 'merging')
      .execute();
    for (const item of items) {
      try {
        await mergeOne(
          database,
          item.id,
          item.default_branch ?? 'main',
          await options.forge(item.project_id),
          now(),
        );
      } catch (error) {
        log(`Merge check for work item ${item.id} failed: ${String(error)}`);
      }
    }
  };

  const watchCodeReviews = async () => {
    const items = await database
      .selectFrom('work_items')
      .select(['work_items.id', 'work_items.project_id'])
      .where('work_items.state', '=', 'waiting')
      .where('work_items.waiting_kind', '=', 'code_review')
      .execute();
    for (const item of items) {
      try {
        await codeReviewOne(
          database,
          item.id,
          await options.forge(item.project_id),
        );
      } catch (error) {
        log(`Review check for work item ${item.id} failed: ${String(error)}`);
      }
    }
  };

  const closeReturned = async () => {
    const rows = await database
      .selectFrom('work_item_records as returned')
      .innerJoin('work_items', 'work_items.id', 'returned.work_item_id')
      .select([
        'returned.id',
        'returned.payload',
        'returned.work_item_id',
        'work_items.project_id',
      ])
      .where('returned.kind', '=', 'returned_to_design')
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('work_item_records as closed')
              .select('closed.id')
              .where('closed.kind', '=', 'pull_request_closed')
              .whereRef('closed.work_item_id', '=', 'returned.work_item_id')
              .whereRef('closed.id', '>', 'returned.id'),
          ),
        ),
      )
      .execute();
    for (const row of rows) {
      const payload = (row.payload ?? {}) as {
        pullRequest?: LivePullRequest | null;
        reason?: string;
      };
      const pullRequest = payload.pullRequest;
      if (pullRequest == null) continue;
      try {
        const forge = await options.forge(row.project_id);
        // A retry after a half-done close must not comment on the pull request a second time.
        if ((await forge.pullRequest(pullRequest.number)).state === 'open') {
          await forge.closePullRequest(
            pullRequest.number,
            `Returned to design: ${payload.reason ?? ''}`,
          );
        }
        await forge.deleteBranch(pullRequest.branch);
        await database
          .insertInto('work_item_records')
          .values({
            kind: 'pull_request_closed',
            payload: JSON.stringify({
              kind: 'pull_request_closed',
              number: pullRequest.number,
            }),
            run_id: null,
            work_item_id: row.work_item_id,
          })
          .execute();
      } catch (error) {
        log(
          `Closing the pull request of work item ${row.work_item_id} failed: ${String(error)}`,
        );
      }
    }
  };

  const pass = async () => {
    // An approval found here merges in the same pass.
    await watchCodeReviews();
    await watchMerging();
    await closeReturned();
  };

  return {
    nudge() {
      if (running !== null) {
        again = true;
        return;
      }
      running = (async () => {
        do {
          again = false;
          try {
            await pass();
          } catch (error) {
            log(`The merge pass failed: ${String(error)}`);
          }
        } while (again);
        running = null;
      })();
    },
    pass,
  };
}

async function mergeOne(
  database: Kysely<Database>,
  itemId: string,
  base: string,
  forge: Forge,
  now: Date,
): Promise<void> {
  const pullRequest = await livePullRequest(database, itemId);
  const approval = await latestApproval(database, itemId);
  if (pullRequest === null || approval === null) {
    throw new Error('An approved item has no pull request or approval.');
  }
  const current = await forge.pullRequest(pullRequest.number);
  if (current.state === 'merged') {
    await forge.deleteBranch(current.branch);
    return merged(database, itemId, base, current.head);
  }
  if (current.state === 'closed') {
    return block(database, itemId, {
      message: `Pull request #${pullRequest.number} was closed without merging.`,
      reason: 'refused',
    });
  }
  if (!sameRevision(current.head, approval.revision)) {
    return block(database, itemId, {
      reason: 'changed_since_approval',
      revision: approval.revision,
      ...approval.reviewer,
    });
  }
  if (current.mergeable === false) {
    return block(database, itemId, { base, reason: 'conflict' });
  }
  const checks = await forge.checks(current.head);
  if (checks.status === 'failure') {
    return block(database, itemId, {
      check: checks.check,
      reason: 'check_failed',
      revision: current.head,
      ...approval.reviewer,
    });
  }
  // A project with no checks merges once any that were going to start would have reported.
  const noChecksYet =
    checks.status === 'none' &&
    now.getTime() - approval.at.getTime() < noChecksGraceMs;
  if (
    checks.status === 'pending' ||
    noChecksYet ||
    current.mergeable === null
  ) {
    return;
  }
  const result = await forge.merge(pullRequest.number, current.head);
  if (!result.merged) {
    return block(
      database,
      itemId,
      result.reason === 'head_moved'
        ? {
            reason: 'changed_since_approval',
            revision: approval.revision,
            ...approval.reviewer,
          }
        : { message: result.message, reason: 'refused' },
    );
  }
  await forge.deleteBranch(current.branch);
  return merged(database, itemId, base, current.head);
}

/**
 * The navigator's own review on GitHub (spec §4.9): only a review submitted by the account the
 * wait was started for, after it started, counts; an approval moves the item on to merge and a
 * changes request sends it back to the builder. Approvals from anyone else are noted, once each.
 */
async function codeReviewOne(
  database: Kysely<Database>,
  itemId: string,
  forge: Forge,
): Promise<void> {
  const waiting = await database
    .selectFrom('work_item_records')
    .select(['created_at', 'payload'])
    .where('work_item_id', '=', itemId)
    .where('kind', '=', 'awaiting_code_review')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  const account = (waiting?.payload as { account?: unknown } | undefined)
    ?.account;
  const pullRequest = await livePullRequest(database, itemId);
  if (
    waiting === undefined ||
    typeof account !== 'string' ||
    pullRequest === null
  ) {
    throw new Error(
      'An item waiting for a code review has no account or pull request.',
    );
  }
  // GitHub keeps whole seconds; a review in the same second as the wait began still counts.
  const since = Math.floor(waiting.created_at.getTime() / 1000) * 1000;
  const reviews = (await forge.reviews(pullRequest.number)).filter(
    (review) => review.submittedAt.getTime() >= since,
  );
  const counted = (review: ForgeReview) =>
    review.login.toLowerCase() === account.toLowerCase();
  const answer = reviews.find(
    (review) =>
      counted(review) &&
      (review.state === 'approved' || review.state === 'changes_requested'),
  );
  if (answer !== undefined) {
    const changes = answer.state === 'changes_requested';
    const comments = changes
      ? await forge.reviewComments(pullRequest.number, answer.id)
      : [];
    await transitionLocked(database, itemId, (current) =>
      current.item.state === 'waiting' &&
      current.item.waitingKind === 'code_review'
        ? {
            actor: { role: 'backend' },
            reason: changes
              ? 'You requested changes on GitHub'
              : 'You approved on GitHub',
            record: {
              body: answer.body,
              comments,
              kind: 'navigator_review',
              login: answer.login,
              reviewId: answer.id,
              url: answer.url,
              verdict: changes ? 'changes_requested' : 'approved',
            },
            to: changes ? 'build_ready' : 'merging',
          }
        : { ok: false as const },
    );
    return;
  }
  const noted = new Set(
    (
      await database
        .selectFrom('work_item_records')
        .select('payload')
        .where('work_item_id', '=', itemId)
        .where('kind', '=', 'review_not_counted')
        .execute()
    ).map((row) => (row.payload as { reviewId?: unknown }).reviewId),
  );
  for (const review of reviews) {
    if (
      counted(review) ||
      review.state !== 'approved' ||
      noted.has(review.id)
    ) {
      continue;
    }
    await database
      .insertInto('work_item_records')
      .values({
        kind: 'review_not_counted',
        payload: JSON.stringify({
          account,
          kind: 'review_not_counted',
          login: review.login,
          reviewId: review.id,
          url: review.url,
        }),
        run_id: null,
        work_item_id: itemId,
      })
      .execute();
  }
}

const noChecksGraceMs = 5 * 60_000;

function sameRevision(head: string, revision: string): boolean {
  const [a, b] = [head.toLowerCase(), revision.toLowerCase()];
  return a.startsWith(b) || b.startsWith(a);
}

async function latestApproval(
  database: Kysely<Database>,
  itemId: string,
): Promise<{
  readonly at: Date;
  readonly reviewer: { readonly reviewer?: string };
  readonly revision: string;
} | null> {
  const row = await database
    .selectFrom('work_item_records')
    .leftJoin('runs', 'runs.id', 'work_item_records.run_id')
    .select([
      'work_item_records.created_at',
      'work_item_records.payload',
      'runs.agent_name',
    ])
    .where('work_item_records.work_item_id', '=', itemId)
    .where('work_item_records.kind', '=', 'review')
    .orderBy('work_item_records.id', 'desc')
    .limit(1)
    .executeTakeFirst();
  const payload = (row?.payload ?? {}) as {
    revision?: unknown;
    verdict?: unknown;
  };
  if (payload.verdict !== 'approved' || typeof payload.revision !== 'string') {
    return null;
  }
  return {
    at: new Date(row?.created_at ?? 0),
    reviewer: row?.agent_name == null ? {} : { reviewer: row.agent_name },
    revision: payload.revision,
  };
}

async function block(
  database: Kysely<Database>,
  itemId: string,
  detail: BlockedDetail,
): Promise<void> {
  const heading = blockedHeading(detail);
  await transitionLocked(database, itemId, (current) =>
    current.item.state === 'merging'
      ? {
          actor: { role: 'backend' },
          reason: heading,
          record: { kind: 'blocked', ...detail },
          to: 'waiting',
          waiting: {
            kind: 'escalation',
            reason: heading,
            returnState: 'merging',
          },
        }
      : { ok: false as const },
  );
}

async function merged(
  database: Kysely<Database>,
  itemId: string,
  base: string,
  sha: string,
): Promise<void> {
  await transitionLocked(database, itemId, (current) =>
    current.item.state === 'merging'
      ? {
          actor: { role: 'backend' },
          reason: 'Merged',
          record: { base, kind: 'merged', sha },
          to: 'done',
        }
      : { ok: false as const },
  );
}
