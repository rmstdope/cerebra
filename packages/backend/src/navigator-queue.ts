import { sql, type Kysely } from 'kysely';

import {
  boardRoutes,
  isRouteAvailable,
  routeUnavailable,
  transitionLocked,
  type BoardRoute,
} from './board.js';
import type { Database } from './database.js';
import type {
  Priority,
  TransitionRequest,
  TransitionResult,
  WaitingKind,
  WorkItemState,
} from './lifecycle.js';

export type QueueEntryKind = 'attention' | 'new' | 'question' | 'review';

export interface QueueEntry {
  readonly askedBy: string | null;
  readonly availableRoutes: readonly BoardRoute[];
  /** Whether it waits because it could not merge or finish (spec §4.5): answered on the item. */
  readonly blocked: boolean;
  readonly description: string;
  readonly id: string;
  readonly kind: QueueEntryKind;
  readonly priority: Priority | null;
  readonly projectId: string;
  readonly projectName: string;
  /** The live run whose question this is; null for a work item. */
  readonly run: { readonly id: string } | null;
  readonly since: Date;
  readonly title: string;
  readonly waitingReason: string | null;
}

/** Something about the instance itself that needs the navigator, outside any project. */
export interface InstanceNotice {
  /** When the failed backup attempt started. */
  readonly at: Date;
  readonly cause: string;
  readonly kind: 'backup_failed';
}

export interface NavigatorQueuePage {
  readonly entries: readonly QueueEntry[];
  readonly notices: readonly InstanceNotice[];
  /** How many entries; notices are not counted. */
  readonly total: number;
}

export type QueueDecision =
  | { readonly direction: 'reopen' }
  | { readonly direction: 'cancel'; readonly reason: string }
  | {
      readonly direction: 'redirect';
      readonly priority?: Priority;
      readonly reason: string;
      readonly to: BoardRoute;
    };

export type QueueRefusalCode = 'not_waiting' | 'refused' | 'route_unavailable';

export interface QueueRefusal {
  readonly code: QueueRefusalCode;
  readonly ok: false;
  readonly reason: string;
}

export type QueueActionResult = { readonly ok: true } | QueueRefusal;

export interface NavigatorQueue {
  answer(itemId: string, answer: string): Promise<QueueActionResult>;
  decide(itemId: string, decision: QueueDecision): Promise<QueueActionResult>;
  list(): Promise<NavigatorQueuePage>;
}

const kindRank: Record<QueueEntryKind, number> = {
  attention: 0,
  question: 1,
  review: 2,
  new: 3,
};

const kindForWait: Record<WaitingKind, QueueEntryKind> = {
  code_review: 'review',
  escalation: 'attention',
  merge: 'review',
  question: 'question',
};

function priorityRank(priority: Priority | null): number {
  return priority === null ? 4 : Number(priority.slice(1));
}

function urgency(a: QueueEntry, b: QueueEntry): number {
  return (
    kindRank[a.kind] - kindRank[b.kind] ||
    priorityRank(a.priority) - priorityRank(b.priority)
  );
}

/**
 * Orders requests within a project by urgency (kind, then priority), then by
 * how long they have waited.
 */
export function compareQueueEntries(a: QueueEntry, b: QueueEntry): number {
  return urgency(a, b) || a.since.getTime() - b.since.getTime();
}

/**
 * Groups entries by project: each project's requests stay together, and the
 * projects follow the urgency of their most urgent request, then their name.
 */
export function orderQueue(entries: readonly QueueEntry[]): QueueEntry[] {
  const groups = new Map<string, QueueEntry[]>();
  for (const entry of [...entries].sort(compareQueueEntries)) {
    const group = groups.get(entry.projectId) ?? [];
    group.push(entry);
    groups.set(entry.projectId, group);
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        urgency(a[0]!, b[0]!) ||
        a[0]!.projectName.localeCompare(b[0]!.projectName),
    )
    .flat();
}

const notWaiting: QueueRefusal = {
  code: 'not_waiting',
  ok: false,
  reason: 'This work no longer waits on the navigator.',
};

function refused(reason: string): QueueRefusal {
  return { code: 'refused', ok: false, reason };
}

function actionResult(
  result: TransitionResult | QueueActionResult,
): QueueActionResult {
  if (result.ok) return { ok: true };
  return 'code' in result ? result : refused(result.reason);
}

function askerName(role: string | null): string | null {
  if (role === null) return null;
  if (role === 'backend') return 'Cerebra';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function projectLabel(name: string, owner: string | null): string {
  return owner === null ? name : `${owner}/${name}`;
}

/** The newest unanswered question of every live run in a project. */
async function runQuestions(database: Kysely<Database>): Promise<QueueEntry[]> {
  const rows = await database
    .selectFrom('run_events as asked')
    .innerJoin('runs', 'runs.id', 'asked.run_id')
    .innerJoin('projects', 'projects.id', 'runs.project_id')
    .select([
      'runs.id as run_id',
      'runs.agent_name',
      'asked.event',
      'asked.created_at',
      'projects.id as project_id',
      'projects.name as project_name',
      'projects.owner as project_owner',
    ])
    .where('runs.status', 'in', ['starting', 'active', 'awaiting_input'])
    .where(sql<string>`asked.event->>'kind'`, '=', 'question')
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('run_events as answer')
            .select('answer.id')
            .whereRef('answer.run_id', '=', 'asked.run_id')
            .where(sql<string>`answer.event->>'kind'`, '=', 'answer')
            .where(
              sql<string>`answer.event->>'questionId'`,
              '=',
              sql<string>`asked.event->>'questionId'`,
            ),
        ),
      ),
    )
    .orderBy('asked.position', 'desc')
    .execute();

  const newest = new Map<string, QueueEntry>();
  for (const row of rows) {
    if (newest.has(row.run_id)) continue;
    const event = row.event as {
      questionId: string;
      questions: readonly { question: string }[];
    };
    const text = event.questions[0]?.question ?? '';
    newest.set(row.run_id, {
      askedBy: row.agent_name ?? 'The assistant',
      availableRoutes: [],
      description: '',
      id: `run:${row.run_id}:${event.questionId}`,
      kind: 'question',
      priority: null,
      projectId: row.project_id,
      projectName: projectLabel(row.project_name, row.project_owner),
      blocked: false,
      run: { id: row.run_id },
      since: row.created_at,
      title: text,
      waitingReason: text,
    });
  }
  return [...newest.values()];
}

/** A failed backup stays in the queue until a later one completes; there is no dismissing it. */
async function backupNotices(
  database: Kysely<Database>,
): Promise<InstanceNotice[]> {
  const latest = await database
    .selectFrom('backups')
    .select(['status', 'started_at', 'cause'])
    .where('status', '<>', 'running')
    .orderBy('started_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  return latest?.status === 'failed'
    ? [
        {
          at: latest.started_at,
          cause: latest.cause ?? '',
          kind: 'backup_failed',
        },
      ]
    : [];
}

export function createNavigatorQueue(
  database: Kysely<Database>,
): NavigatorQueue {
  return {
    async list() {
      const rows = await database
        .selectFrom('work_items')
        .innerJoin('projects', 'projects.id', 'work_items.project_id')
        .select((builder) => [
          'work_items.id',
          'work_items.title',
          'work_items.description',
          'work_items.priority',
          'work_items.state',
          'work_items.waiting_kind',
          'work_items.waiting_reason',
          'work_items.updated_at',
          'projects.id as project_id',
          'projects.name as project_name',
          'projects.owner as project_owner',
          'projects.design_enabled',
          'projects.grooming_enabled',
          'projects.verify_enabled',
          builder
            .selectFrom('work_item_history')
            .select('work_item_history.actor_role')
            .whereRef('work_item_history.work_item_id', '=', 'work_items.id')
            .where('work_item_history.to_state', '=', 'waiting')
            .orderBy('work_item_history.id', 'desc')
            .limit(1)
            .as('asked_by'),
          builder
            .selectFrom('work_item_history')
            .select('work_item_history.created_at')
            .whereRef('work_item_history.work_item_id', '=', 'work_items.id')
            .where('work_item_history.to_state', '=', 'waiting')
            .orderBy('work_item_history.id', 'desc')
            .limit(1)
            .as('waiting_since'),
          builder
            .selectFrom('work_item_records')
            .select((records) =>
              records.fn.max('work_item_records.created_at').as('at'),
            )
            .whereRef('work_item_records.work_item_id', '=', 'work_items.id')
            .where('work_item_records.kind', '=', 'blocked')
            .as('blocked_at'),
        ])
        .where('work_items.state', 'in', ['new', 'waiting'])
        .execute();

      const entries = rows.map((row): QueueEntry => {
        const kind =
          row.state === 'new' || row.waiting_kind === null
            ? 'new'
            : kindForWait[row.waiting_kind];
        const stages = {
          design: row.design_enabled,
          grooming: row.grooming_enabled,
          verify: row.verify_enabled,
        };
        return {
          askedBy: kind === 'question' ? askerName(row.asked_by) : null,
          availableRoutes: boardRoutes.filter((route) =>
            isRouteAvailable(route, stages),
          ),
          // The same test the item's banner uses: a block recorded since it began waiting.
          blocked:
            kind === 'attention' &&
            row.blocked_at !== null &&
            row.waiting_since !== null &&
            new Date(row.blocked_at).getTime() >=
              new Date(row.waiting_since).getTime(),
          description: row.description,
          id: row.id,
          kind,
          priority: row.priority,
          projectId: row.project_id,
          projectName: projectLabel(row.project_name, row.project_owner),
          run: null,
          since: row.updated_at,
          title: row.title,
          waitingReason: row.waiting_reason,
        };
      });

      entries.push(...(await runQuestions(database)));
      return {
        entries: orderQueue(entries),
        notices: await backupNotices(database),
        total: entries.length,
      };
    },

    async answer(itemId, answer) {
      const text = answer.trim();
      if (text === '') return refused('An answer cannot be empty.');
      return actionResult(
        await transitionLocked<QueueRefusal>(database, itemId, ({ item }) =>
          item.state !== 'waiting' ||
          item.waitingKind !== 'question' ||
          item.returnState === null
            ? notWaiting
            : {
                actor: { role: 'navigator' },
                record: {
                  answer: text,
                  kind: 'answer',
                  question: item.waitingReason,
                },
                to: item.returnState,
              },
        ),
      );
    },

    async decide(itemId, decision) {
      return actionResult(
        await transitionLocked<QueueRefusal>(
          database,
          itemId,
          ({ item, context }): TransitionRequest | QueueRefusal => {
            if (item.state !== 'new' && item.state !== 'waiting') {
              return notWaiting;
            }
            if (decision.direction === 'cancel') {
              return {
                actor: { role: 'navigator' },
                reason: decision.reason,
                to: 'cancelled',
              };
            }
            if (decision.direction === 'reopen') {
              if (item.returnState === null) {
                return refused('New work has nothing to reopen.');
              }
              const to: WorkItemState =
                item.returnState === 'merging'
                  ? 'build_ready'
                  : item.returnState;
              return {
                actor: { role: 'navigator' },
                record: { kind: 'reopen' },
                to,
              };
            }
            if (!isRouteAvailable(decision.to, context.stages)) {
              return routeUnavailable;
            }
            return {
              actor: { role: 'navigator' },
              ...(decision.priority === undefined
                ? {}
                : { priority: decision.priority }),
              reason: decision.reason,
              record: { kind: item.state === 'new' ? 'triage' : 'redirect' },
              to: decision.to,
            };
          },
        ),
      );
    },
  };
}
