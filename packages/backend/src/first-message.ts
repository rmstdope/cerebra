import type { Kysely, Transaction } from 'kysely';

import {
  blockedHeading,
  livePullRequest,
  type BlockedDetail,
  type LivePullRequest,
  type ReviewFinding,
} from './board.js';
import type { Database } from './database.js';

export interface FirstMessageInput {
  readonly description: string;
  readonly key: string;
  /** The newest of the navigator's answers and the blocks it answered, oldest first. */
  readonly history: readonly FirstMessageEvent[];
  readonly pullRequest: LivePullRequest | null;
  readonly role: string;
  readonly title: string;
  readonly type: string;
}

export type FirstMessageEvent =
  | ({ readonly kind: 'blocked' } & BlockedDetail)
  | {
      readonly findings: readonly ReviewFinding[];
      readonly kind: 'review';
      readonly revision: string;
      readonly verdict: 'approved' | 'changes_requested';
    }
  | { readonly kind: 'returned_to_design'; readonly reason: string }
  | { readonly kind: 'sent_back' };

/**
 * What a run is told first (spec §4.4): its item, and, when the item has been round the loop,
 * the pull request to continue and why it came back.
 */
export function firstMessage(input: FirstMessageInput): string {
  const parts = [
    `${input.key} (${input.type}): ${input.title}`,
    input.description,
  ];
  const latest = input.history.at(-1);
  if (latest?.kind === 'returned_to_design') {
    parts.push(
      `The navigator returned this item to design: “${latest.reason}” Its earlier pull request was closed.`,
    );
  }
  const pullRequest = input.pullRequest;
  if (pullRequest !== null && input.role === 'reviewer') {
    parts.push(
      `Review pull request ${pullRequest.url} (branch ${pullRequest.branch}). Record the revision you reviewed.`,
    );
  }
  if (pullRequest !== null && input.role === 'builder') {
    parts.push(
      `Continue pull request ${pullRequest.url} on branch ${pullRequest.branch}; push your corrections to that branch rather than opening a new pull request.`,
    );
    if (latest?.kind === 'review' && latest.verdict === 'changes_requested') {
      parts.push(
        [
          `The reviewer requested changes on revision ${latest.revision}:`,
          ...latest.findings.map(
            (finding) =>
              `- ${finding.severity === 'blocking' ? 'Blocking' : 'Advisory'}: ${finding.file}${finding.line === undefined ? '' : `:${finding.line}`} — ${finding.problem}`,
          ),
        ].join('\n'),
      );
    }
    const blocked = input.history.at(-2);
    if (latest?.kind === 'sent_back') {
      parts.push(
        blocked?.kind === 'blocked'
          ? `The navigator sent this back to you after “${blockedHeading(blocked)}”${blocked.check === undefined ? '' : ` (${blocked.check} failed)`}.`
          : 'The navigator sent this back to you.',
      );
    }
  }
  return parts.filter((part) => part.trim() !== '').join('\n\n');
}

const historyKinds = [
  'review',
  'blocked',
  'sent_back',
  'returned_to_design',
] as const;

/** Reads what `firstMessage` needs for the item a run has just claimed. */
export async function loadFirstMessage(
  database: Kysely<Database> | Transaction<Database>,
  itemId: string,
  role: string,
): Promise<string> {
  const item = await database
    .selectFrom('work_items')
    .select(['description', 'key', 'title', 'type'])
    .where('id', '=', itemId)
    .executeTakeFirstOrThrow();
  const rows = await database
    .selectFrom('work_item_records')
    .select('payload')
    .where('work_item_id', '=', itemId)
    .where('kind', 'in', historyKinds)
    .orderBy('id', 'desc')
    .limit(2)
    .execute();
  return firstMessage({
    ...item,
    history: rows
      .reverse()
      .map((row) => row.payload as unknown as FirstMessageEvent),
    pullRequest: await livePullRequest(database, itemId),
    role,
  });
}
