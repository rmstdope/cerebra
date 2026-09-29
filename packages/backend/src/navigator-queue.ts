import type { Kysely } from 'kysely';

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
  readonly description: string;
  readonly id: string;
  readonly kind: QueueEntryKind;
  readonly priority: Priority | null;
  readonly projectId: string;
  readonly projectName: string;
  readonly since: Date;
  readonly title: string;
  readonly waitingReason: string | null;
}

export interface NavigatorQueuePage {
  readonly entries: readonly QueueEntry[];
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
          description: row.description,
          id: row.id,
          kind,
          priority: row.priority,
          projectId: row.project_id,
          projectName:
            row.project_owner === null
              ? row.project_name
              : `${row.project_owner}/${row.project_name}`,
          since: row.updated_at,
          title: row.title,
          waitingReason: row.waiting_reason,
        };
      });

      return { entries: orderQueue(entries), total: entries.length };
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
