import {
  sql,
  type Kysely,
  type SelectQueryBuilder,
  type Transaction,
} from 'kysely';

import type { Database, WorkItemType } from './database.js';
import {
  createWorkItem,
  runEndedRequest,
  transition,
  type LifecycleContext,
  type LifecycleRole,
  type BuildEvidence,
  type Priority,
  type TransitionRequest,
  type TransitionResult,
  type WorkItem,
  type WorkItemState,
} from './lifecycle.js';

type RunRole = Exclude<LifecycleRole, 'backend' | 'navigator'>;
type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

interface CreateProject {
  readonly id: string;
  readonly name: string;
  readonly stages?: Partial<LifecycleContext['stages']>;
}

interface CreateWorkItem {
  readonly description?: string;
  /** The item the filing run held, when it discovered this one while working (spec §4.10). */
  readonly discoveredFromId?: string;
  /** The run that filed it; absent when the navigator did. */
  readonly filedByRunId?: string;
  readonly id: string;
  readonly priority?: WorkItem['priority'];
  readonly projectId: string;
  readonly state?: WorkItemState;
  readonly title?: string;
  readonly type?: WorkItemType;
}

export interface BoardWorkItem {
  readonly createdAt: Date;
  readonly description: string;
  readonly id: string;
  /** The project's prefix and the item's number, `web-42` (spec §4.1). */
  readonly key: string;
  readonly priority: WorkItem['priority'];
  readonly state: WorkItemState;
  readonly title: string;
  readonly type: WorkItemType;
  readonly updatedAt: Date;
}

export interface BoardHistoryEntry {
  readonly actorRole: string;
  readonly createdAt: Date;
  readonly fromState: WorkItemState;
  readonly reason: string | null;
  readonly toState: WorkItemState;
}

export interface BoardComment {
  readonly body: string;
  readonly createdAt: Date;
  readonly id: number;
}

export interface BoardRecord {
  readonly createdAt: Date;
  readonly kind: string;
  readonly record: unknown;
}

/** One step of an item's delivery story (spec §4.11): a plan, a checks report, a pull request. */
export type DeliveryEvent = {
  readonly agentName: string | null;
  readonly at: Date;
  readonly id: string;
  readonly runId: string | null;
} & (
  | { readonly kind: 'plan' }
  | { readonly kind: 'checks'; readonly passed: boolean }
  | {
      readonly kind: 'pull_request';
      readonly number: number;
      readonly title: string | null;
      readonly url: string;
    }
  | {
      readonly kind: 'review';
      readonly findings: readonly ReviewFinding[];
      readonly revision: string;
      readonly url: string | null;
      readonly verdict: 'approved' | 'changes_requested';
    }
  | {
      readonly kind: 'rework_started';
      readonly maxRounds: number;
      readonly round: number;
    }
  | ({ readonly kind: 'blocked' } & BlockedDetail)
  | { readonly kind: 'sent_back' }
  | { readonly kind: 'returned_to_design'; readonly reason: string }
  | { readonly kind: 'merged'; readonly base: string; readonly sha: string }
);

export interface ReviewFinding {
  readonly file: string;
  readonly line?: number;
  readonly problem: string;
  readonly severity: 'advisory' | 'blocking';
}

/** Why a merge cannot happen, or a run could not finish (spec §4.5): the item waits for the navigator. */
export type BlockedReason =
  | 'changed_since_approval'
  | 'check_failed'
  | 'conflict'
  | 'too_many_attempts'
  | 'too_many_rounds';

export interface BlockedDetail {
  /** The default branch the pull request merges into. */
  readonly base?: string;
  /** The failed required check's name. */
  readonly check?: string;
  /** How many rounds or attempts were used. */
  readonly count?: number;
  readonly reason: BlockedReason;
  /** The revision the failure or the approval concerns. */
  readonly revision?: string;
  /** The agent that approved the revision. */
  readonly reviewer?: string;
}

/** The heading a person sees for a block (the item's `waiting_reason`). */
export function blockedHeading(detail: BlockedDetail): string {
  switch (detail.reason) {
    case 'changed_since_approval':
      return "Can't merge: changed since approval";
    case 'check_failed':
      return "Can't merge: a required check failed";
    case 'conflict':
      return `Can't merge: the branch conflicts with ${detail.base ?? 'main'}`;
    case 'too_many_attempts':
      return 'Stopped: too many attempts';
    case 'too_many_rounds':
      return "Can't merge: too many rounds";
  }
}

/** What the item waits on now, after its last delivery event; null when nothing is shown. */
export type DeliveryCurrent =
  | {
      readonly kind: 'waiting_for_review';
      /** The agent that is, or will next be, reviewing; null when the project has none enabled. */
      readonly reviewer: string | null;
    }
  | { readonly kind: 'waiting_for_checks' }
  | null;

/** The block the item waits on the navigator for; null once it has moved on. */
export interface DeliveryBlocked {
  /** Whether the project's design stage is on, so the item can go back to design. */
  readonly canReturnToDesign: boolean;
  readonly event: Extract<DeliveryEvent, { kind: 'blocked' }>;
}

/** The pull request a builder continues, while the item has not gone back to design. */
export interface LivePullRequest {
  readonly branch: string;
  readonly head: string;
  readonly number: number;
  readonly url: string;
}

export type AnswerResult =
  | TransitionResult
  | {
      readonly code: 'not_waiting' | 'reason_required' | 'route_unavailable';
      readonly ok: false;
      readonly reason: string;
    };

export interface DeliveryActivity {
  readonly blocked: DeliveryBlocked | null;
  readonly current: DeliveryCurrent;
  /** Pass as `before` to read the 50 events preceding these; null when none precede them. */
  readonly earlierCursor: string | null;
  readonly events: readonly DeliveryEvent[];
  readonly latestChecks: Extract<DeliveryEvent, { kind: 'checks' }> | null;
  readonly latestPullRequest: Extract<
    DeliveryEvent,
    { kind: 'pull_request' }
  > | null;
}

export interface BoardProvenance {
  readonly discoveredFromId: string | null;
  /** The run that filed the item, or `null` when the navigator filed it. */
  readonly filedBy: {
    readonly agentName: string | null;
    readonly role: string;
    readonly runId: string;
  } | null;
}

export type BoardRoute = 'build_ready' | 'design_ready' | 'grooming_ready';
export type BoardSort = 'newest' | 'oldest' | 'priority';

export const boardRoutes: readonly BoardRoute[] = [
  'grooming_ready',
  'design_ready',
  'build_ready',
];
export const boardSorts: readonly BoardSort[] = [
  'newest',
  'oldest',
  'priority',
];

export interface BoardFilters {
  readonly priority?: Priority | 'none';
  readonly search?: string;
  readonly state?: WorkItemState;
}

export interface BoardQuery extends BoardFilters {
  readonly cursor?: string;
  readonly limit?: number;
  readonly snapshot?: string;
  readonly sort?: BoardSort;
}

/** Who filed a listed item, fixed when it was filed; null when the navigator did (spec §4.10). */
export interface BoardFiledBy {
  readonly agentName: string | null;
  readonly discoveredFrom: {
    readonly id: string;
    readonly title: string;
  } | null;
  readonly role: string;
}

export interface BoardListedWorkItem extends BoardWorkItem {
  readonly filedBy: BoardFiledBy | null;
}

export interface BoardPage {
  readonly items: readonly BoardListedWorkItem[];
  readonly nextCursor: string | null;
  readonly snapshot: string;
  readonly total: number;
}

export type TriageResult =
  | TransitionResult
  | {
      readonly code: 'route_unavailable';
      readonly ok: false;
      readonly reason: string;
    };

export class WorkItemNotFoundError extends Error {
  constructor(itemId: string) {
    super(`Work item ${itemId} does not exist.`);
    this.name = 'WorkItemNotFoundError';
  }
}

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} does not exist.`);
    this.name = 'ProjectNotFoundError';
  }
}

const defaultPageSize = 25;
const stageForRoute: Record<
  BoardRoute,
  keyof LifecycleContext['stages'] | null
> = {
  build_ready: null,
  design_ready: 'design',
  grooming_ready: 'grooming',
};

export interface Board {
  claim(itemId: string, role: RunRole): Promise<TransitionResult>;
  addComment(itemId: string, body: string): Promise<BoardComment>;
  cancel(itemId: string, reason?: string): Promise<TransitionResult>;
  countArrivals(
    projectId: string,
    query: BoardFilters & { readonly snapshot: string },
  ): Promise<number>;
  createProject(input: CreateProject): Promise<void>;
  deliveryActivity(
    itemId: string,
    page?: { readonly before?: string },
  ): Promise<DeliveryActivity>;
  createWorkItem(input: CreateWorkItem): Promise<void>;
  /** The navigator returns a blocked item to design, closing its pull request with the reason. */
  returnToDesign(itemId: string, reason: string): Promise<AnswerResult>;
  /** The navigator sends a blocked item back to the builder (spec §4.4). */
  sendBack(itemId: string): Promise<AnswerResult>;
  getHistory(itemId: string): Promise<readonly BoardHistoryEntry[]>;
  getProvenance(itemId: string): Promise<BoardProvenance>;
  listRecords(itemId: string): Promise<readonly BoardRecord[]>;
  getWorkItem(itemId: string): Promise<BoardWorkItem>;
  listComments(itemId: string): Promise<readonly BoardComment[]>;
  listWorkItems(projectId: string, query?: BoardQuery): Promise<BoardPage>;
  triage(
    itemId: string,
    priority: Priority,
    route: BoardRoute,
    reason?: string,
  ): Promise<TriageResult>;
  transition(
    itemId: string,
    request: TransitionRequest,
  ): Promise<TransitionResult>;
}

export const filingLockKey = 7_294_130_001;

export function createBoard(database: Kysely<Database>): Board {
  return {
    async addComment(itemId, body) {
      if (body.trim().length === 0) {
        throw new Error('A comment cannot be empty.');
      }
      await assertWorkItemExists(database, itemId);
      const comment = await database
        .insertInto('work_item_comments')
        .values({ body: body.trim(), work_item_id: itemId })
        .returning(['body', 'created_at', 'id'])
        .executeTakeFirstOrThrow();
      return {
        body: comment.body,
        createdAt: comment.created_at,
        id: comment.id,
      };
    },

    async createProject({ id, name, stages = {} }) {
      await database
        .insertInto('projects')
        .values({
          id,
          name,
          grooming_enabled: stages.grooming ?? true,
          design_enabled: stages.design ?? true,
          verify_enabled: stages.verify ?? true,
        })
        .execute();
    },

    async createWorkItem({
      discoveredFromId,
      filedByRunId,
      id,
      projectId,
      priority,
      state = 'new',
      title = '',
      description = '',
      type = 'feature',
    }) {
      await assertProjectExists(database, projectId);
      const item = createWorkItem({ priority, state });

      await database.transaction().execute(async (transaction) => {
        // Filing is serialised so filed_sequence order is commit order; a
        // list snapshot (the highest sequence it saw) then never skips an
        // item that commits later with a lower sequence.
        await sql`select pg_advisory_xact_lock(${filingLockKey})`.execute(
          transaction,
        );
        await transaction
          .insertInto('work_items')
          .values({
            id,
            project_id: projectId,
            state: item.state,
            description,
            title,
            priority: item.priority,
            holder_run_id: item.holderRunId,
            waiting_kind: item.waitingKind,
            waiting_reason: item.waitingReason,
            return_state: item.returnState,
            attempts: item.attempts,
            rounds: item.rounds,
            discovered_from_id: discoveredFromId ?? null,
            filed_by_run_id: filedByRunId ?? null,
            type,
          })
          .execute();
      });
    },

    async deliveryActivity(itemId, page = {}) {
      await assertWorkItemExists(database, itemId);
      const pageSize = 50;
      const deliveryKinds = [...deliveryRecordKinds];
      const base = database
        .selectFrom('work_item_records')
        .leftJoin('runs', 'runs.id', 'work_item_records.run_id')
        .select([
          'work_item_records.id',
          'work_item_records.created_at',
          'work_item_records.kind',
          'work_item_records.payload',
          'work_item_records.run_id',
          'runs.agent_name',
        ])
        .where('work_item_records.work_item_id', '=', itemId)
        .where('work_item_records.kind', 'in', deliveryKinds);
      const before =
        page.before !== undefined && /^\d+$/.test(page.before)
          ? Number(page.before)
          : undefined;
      const rows = await (
        before === undefined
          ? base
          : base.where('work_item_records.id', '<', before)
      )
        .orderBy('work_item_records.id', 'desc')
        .limit(pageSize + 1)
        .execute();
      const shown = rows.slice(0, pageSize).reverse();
      const latest = async (kind: string) => {
        const row = await base
          .where('work_item_records.kind', '=', kind)
          .orderBy('work_item_records.id', 'desc')
          .limit(1)
          .executeTakeFirst();
        return row === undefined ? null : toDeliveryEvent(row);
      };
      const [latestChecks, latestPullRequest, current, blocked] =
        await Promise.all([
          latest('checks'),
          latest('pull_request'),
          deliveryCurrent(database, itemId),
          deliveryBlocked(database, itemId),
        ]);
      return {
        blocked,
        current,
        earlierCursor:
          rows.length > pageSize ? String(shown[0]?.id ?? '') : null,
        events: shown.map(toDeliveryEvent),
        latestChecks: latestChecks as DeliveryActivity['latestChecks'],
        latestPullRequest:
          latestPullRequest as DeliveryActivity['latestPullRequest'],
      };
    },

    async returnToDesign(itemId, reason) {
      const trimmed = reason.trim();
      if (trimmed === '') {
        return {
          code: 'reason_required',
          ok: false,
          reason:
            'Give a reason so the designer and the next builder know what to change.',
        };
      }
      const pullRequest = await livePullRequest(database, itemId);
      return answerBlocked(database, itemId, (current) =>
        current.context.stages.design
          ? {
              actor: { role: 'navigator' },
              reason: `Returned to design: ${trimmed}`,
              record: {
                kind: 'returned_to_design',
                pullRequest,
                reason: trimmed,
              },
              to: 'design_ready',
            }
          : { ...routeUnavailable },
      );
    },

    async sendBack(itemId) {
      return answerBlocked(database, itemId, () => ({
        actor: { role: 'navigator' },
        reason: 'Sent back to the builder',
        record: { kind: 'sent_back' },
        to: 'build_ready',
      }));
    },

    async getProvenance(itemId) {
      await assertWorkItemExists(database, itemId);
      const row = await database
        .selectFrom('work_items')
        .leftJoin('runs', 'runs.id', 'work_items.filed_by_run_id')
        .select([
          'work_items.discovered_from_id',
          'runs.id as run_id',
          'runs.agent_name',
          'runs.role',
        ])
        .where('work_items.id', '=', itemId)
        .executeTakeFirstOrThrow();
      return {
        discoveredFromId: row.discovered_from_id,
        filedBy:
          row.run_id === null || row.role === null
            ? null
            : { agentName: row.agent_name, role: row.role, runId: row.run_id },
      };
    },

    async listRecords(itemId) {
      await assertWorkItemExists(database, itemId);
      const rows = await database
        .selectFrom('work_item_records')
        .select(['created_at', 'kind', 'payload'])
        .where('work_item_id', '=', itemId)
        .orderBy('id', 'asc')
        .execute();
      return rows.map((row) => ({
        createdAt: row.created_at,
        kind: row.kind,
        record: row.payload,
      }));
    },

    async listWorkItems(projectId, query = {}) {
      await assertProjectExists(database, projectId);
      const snapshot: string =
        query.snapshot ??
        (await database
          .selectFrom('work_items')
          .select(
            sql<string>`coalesce(max(filed_sequence), 0)::text`.as('snapshot'),
          )
          .executeTakeFirstOrThrow()
          .then((row) => String(row.snapshot)));
      const limit = query.limit ?? defaultPageSize;
      const offset = query.cursor === undefined ? 0 : Number(query.cursor);
      let rows = filtered(
        database.selectFrom('work_items').select(boardColumns),
        projectId,
        query,
      ).where('filed_sequence', '<=', snapshot);
      rows =
        query.sort === 'oldest'
          ? rows.orderBy('filed_sequence', 'asc')
          : query.sort === 'priority'
            ? rows
                .orderBy(sql`priority asc nulls last`)
                .orderBy('filed_sequence', 'desc')
            : rows.orderBy('filed_sequence', 'desc');
      const page = await rows
        .limit(limit + 1)
        .offset(offset)
        .execute();

      const total = await filtered(
        database
          .selectFrom('work_items')
          .select((builder) => builder.fn.countAll<string>().as('count')),
        projectId,
        query,
      )
        .where('filed_sequence', '<=', snapshot)
        .executeTakeFirstOrThrow();

      const items = page.slice(0, limit).map(toBoardWorkItem);
      const filedBy = await filedByOf(
        database,
        items.map((item) => item.id),
      );
      return {
        items: items.map((item) => ({
          ...item,
          filedBy: filedBy.get(item.id) ?? null,
        })),
        nextCursor: page.length > limit ? String(offset + limit) : null,
        snapshot,
        total: Number(total.count),
      };
    },

    async countArrivals(projectId, query) {
      await assertProjectExists(database, projectId);
      const row = await filtered(
        database
          .selectFrom('work_items')
          .select((builder) => builder.fn.countAll<string>().as('count')),
        projectId,
        query,
      )
        .where('filed_sequence', '>', query.snapshot)
        .executeTakeFirstOrThrow();
      return Number(row.count);
    },

    async getWorkItem(itemId) {
      await assertWorkItemExists(database, itemId);
      const row = await database
        .selectFrom('work_items')
        .select(boardColumns)
        .where('id', '=', itemId)
        .executeTakeFirst();
      if (row === undefined) {
        throw new WorkItemNotFoundError(itemId);
      }
      return toBoardWorkItem(row);
    },

    async getHistory(itemId) {
      await assertWorkItemExists(database, itemId);
      return database
        .selectFrom('work_item_history')
        .select([
          'actor_role',
          'created_at',
          'from_state',
          'reason',
          'to_state',
        ])
        .where('work_item_id', '=', itemId)
        .orderBy('created_at asc')
        .execute()
        .then((rows) =>
          rows.map((row) => ({
            actorRole: row.actor_role,
            createdAt: row.created_at,
            fromState: row.from_state as WorkItemState,
            reason: row.reason,
            toState: row.to_state as WorkItemState,
          })),
        );
    },

    async listComments(itemId) {
      await assertWorkItemExists(database, itemId);
      return database
        .selectFrom('work_item_comments')
        .select(['body', 'created_at', 'id'])
        .where('work_item_id', '=', itemId)
        .orderBy('created_at asc')
        .execute()
        .then((rows) =>
          rows.map((row) => ({
            body: row.body,
            createdAt: row.created_at,
            id: row.id,
          })),
        );
    },

    async transition(itemId, request) {
      return database.transaction().execute(async (transactionDatabase) => {
        const current = await getLockedItem(transactionDatabase, itemId);
        const result = transition(current.item, request, current.context);

        if (!result.ok) {
          return result;
        }

        await persistTransition(
          transactionDatabase,
          itemId,
          current.item,
          result,
          request,
        );
        return result;
      });
    },

    async triage(itemId, priority, route, reason) {
      return transitionLocked<typeof routeUnavailable>(
        database,
        itemId,
        (current) => {
          if (!isRouteAvailable(route, current.context.stages)) {
            return routeUnavailable;
          }
          return {
            actor: { role: 'navigator' },
            priority,
            record: { kind: 'triage' },
            ...(reason === undefined ? {} : { reason }),
            to: route,
          };
        },
      );
    },

    async cancel(itemId, reason) {
      return this.transition(itemId, {
        actor: { role: 'navigator' },
        ...(reason === undefined ? {} : { reason }),
        to: 'cancelled',
      });
    },

    async claim(itemId, role) {
      return database
        .transaction()
        .execute(async (transactionDatabase) => {
          const runId = crypto.randomUUID();
          await transactionDatabase
            .insertInto('runs')
            .values({ id: runId, role, status: 'active' })
            .execute();
          const result = await claimForRun(
            transactionDatabase,
            itemId,
            runId,
            role,
          );
          if (!result.ok) {
            throw new ClaimRefusedError(result.reason);
          }
          return result;
        })
        .catch((error: unknown) => {
          if (error instanceof ClaimRefusedError) {
            return { ok: false as const, reason: error.message };
          }
          throw error;
        });
    },
  };
}

class ClaimRefusedError extends Error {}

/**
 * Claims a queued item for a run already inserted in the caller's transaction (spec §4.4): the
 * item moves to the role's working state with the run as its holder, or nothing changes and the
 * refusal is returned for the caller to roll back.
 */
export async function claimForRun(
  database: Transaction<Database>,
  itemId: string,
  runId: string,
  role: RunRole,
): Promise<TransitionResult> {
  const current = await getLockedItem(database, itemId);
  const request: TransitionRequest = {
    actor: { role: 'backend', runId },
    record: { kind: 'claim', role },
    to: workingStateFor(role),
  };
  const result = transition(current.item, request, current.context);
  if (result.ok) {
    await persistTransition(database, itemId, current.item, result, {
      actor: request.actor,
      to: result.item.state,
    });
    if (
      role === 'builder' &&
      (await livePullRequest(database, itemId)) !== null
    ) {
      await database
        .insertInto('work_item_records')
        .values({
          kind: 'rework_started',
          payload: JSON.stringify({
            kind: 'rework_started',
            maxRounds: current.context.maxRounds,
            round: current.item.rounds + 1,
          }),
          run_id: runId,
          work_item_id: itemId,
        })
        .execute();
    }
  }
  return result;
}

export const routeUnavailable = {
  code: 'route_unavailable' as const,
  ok: false as const,
  reason: 'That next step is not available for this project.',
};

export function isRouteAvailable(
  route: BoardRoute,
  stages: LifecycleContext['stages'],
): boolean {
  const stage = stageForRoute[route];
  return stage === null || stages[stage];
}

export interface LockedWorkItem {
  readonly context: LifecycleContext;
  readonly item: WorkItem;
}

/**
 * Applies one lifecycle transition inside a transaction that locks the item,
 * so a caller's precondition and the write see the same row. `decide` returns
 * the request to apply, or a refusal to return unchanged.
 */
export async function transitionLocked<R extends { readonly ok: false }>(
  database: Kysely<Database>,
  itemId: string,
  decide: (current: LockedWorkItem) => TransitionRequest | R,
): Promise<TransitionResult | R> {
  return database.transaction().execute(async (transactionDatabase) => {
    const current = await getLockedItem(transactionDatabase, itemId);
    const request = decide(current);
    if ('ok' in request) {
      return request;
    }
    const result = transition(current.item, request, current.context);
    if (result.ok) {
      await persistTransition(
        transactionDatabase,
        itemId,
        current.item,
        result,
        request,
      );
    }
    return result;
  });
}

async function filedByOf(
  database: Kysely<Database>,
  itemIds: readonly string[],
): Promise<Map<string, BoardFiledBy>> {
  if (itemIds.length === 0) return new Map();
  const rows = await database
    .selectFrom('work_items as item')
    .innerJoin('runs', 'runs.id', 'item.filed_by_run_id')
    .leftJoin(
      'work_items as original',
      'original.id',
      'item.discovered_from_id',
    )
    .select([
      'item.id',
      'runs.agent_name',
      'runs.role',
      'original.id as original_id',
      'original.title as original_title',
    ])
    .where('item.id', 'in', itemIds)
    .execute();
  return new Map(
    rows.map((row) => [
      row.id,
      {
        agentName: row.agent_name,
        discoveredFrom:
          row.original_id === null || row.original_title === null
            ? null
            : { id: row.original_id, title: row.original_title },
        role: row.role,
      },
    ]),
  );
}

const boardColumns = [
  'created_at',
  'description',
  'id',
  'key',
  'priority',
  'state',
  'title',
  'type',
  'updated_at',
] as const;

function filtered<O>(
  query: SelectQueryBuilder<Database, 'work_items', O>,
  projectId: string,
  filters: BoardFilters,
): SelectQueryBuilder<Database, 'work_items', O> {
  let next = query.where('project_id', '=', projectId);
  if (filters.state !== undefined) {
    next = next.where('state', '=', filters.state);
  }
  if (filters.priority === 'none') {
    next = next.where('priority', 'is', null);
  } else if (filters.priority !== undefined) {
    next = next.where('priority', '=', filters.priority);
  }
  const search = filters.search?.trim();
  if (search) {
    const pattern = `%${search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    next = next.where((builder) =>
      builder.or([
        builder('title', 'ilike', pattern),
        builder('description', 'ilike', pattern),
      ]),
    );
  }
  return next;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function assertProjectExists(
  database: DatabaseExecutor,
  projectId: string,
): Promise<void> {
  if (!uuidPattern.test(projectId)) {
    throw new ProjectNotFoundError(projectId);
  }
  const row = await database
    .selectFrom('projects')
    .select('id')
    .where('id', '=', projectId)
    .executeTakeFirst();
  if (row === undefined) {
    throw new ProjectNotFoundError(projectId);
  }
}

async function assertWorkItemExists(
  database: DatabaseExecutor,
  itemId: string,
): Promise<void> {
  if (!uuidPattern.test(itemId)) {
    throw new WorkItemNotFoundError(itemId);
  }
  const row = await database
    .selectFrom('work_items')
    .select('id')
    .where('id', '=', itemId)
    .executeTakeFirst();
  if (row === undefined) {
    throw new WorkItemNotFoundError(itemId);
  }
}

function toBoardWorkItem(row: {
  readonly created_at: Date;
  readonly description: string;
  readonly id: string;
  readonly key: string;
  readonly priority: WorkItem['priority'];
  readonly state: WorkItemState;
  readonly title: string;
  readonly type: WorkItemType;
  readonly updated_at: Date;
}): BoardWorkItem {
  return {
    createdAt: row.created_at,
    description: row.description,
    id: row.id,
    key: row.key,
    priority: row.priority,
    state: row.state,
    title: row.title,
    type: row.type,
    updatedAt: row.updated_at,
  };
}

function toDeliveryEvent(row: {
  readonly agent_name: string | null;
  readonly created_at: Date;
  readonly id: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly run_id: string | null;
}): DeliveryEvent {
  const common = {
    agentName: row.agent_name,
    at: row.created_at,
    id: String(row.id),
    runId: row.run_id,
  };
  const payload = (
    typeof row.payload === 'object' && row.payload !== null ? row.payload : {}
  ) as Record<string, unknown>;
  if (row.kind === 'checks') {
    return { ...common, kind: 'checks', passed: payload.passed === true };
  }
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isInteger(value) ? value : 0;
  switch (row.kind) {
    case 'review':
      return {
        ...common,
        findings: Array.isArray(payload.findings)
          ? (payload.findings as ReviewFinding[])
          : [],
        kind: 'review',
        revision: text(payload.revision),
        url: typeof payload.url === 'string' ? payload.url : null,
        verdict:
          payload.verdict === 'approved' ? 'approved' : 'changes_requested',
      };
    case 'rework_started':
      return {
        ...common,
        kind: 'rework_started',
        maxRounds: count(payload.maxRounds),
        round: count(payload.round),
      };
    case 'blocked':
      return {
        ...common,
        kind: 'blocked',
        reason: payload.reason as BlockedReason,
        ...(['base', 'check', 'revision', 'reviewer'] as const).reduce(
          (detail, field) =>
            typeof payload[field] === 'string'
              ? { ...detail, [field]: payload[field] }
              : detail,
          {},
        ),
        ...(typeof payload.count === 'number' ? { count: payload.count } : {}),
      };
    case 'sent_back':
      return { ...common, kind: 'sent_back' };
    case 'returned_to_design':
      return {
        ...common,
        kind: 'returned_to_design',
        reason: text(payload.reason),
      };
    case 'merged':
      return {
        ...common,
        base: text(payload.base),
        kind: 'merged',
        sha: text(payload.sha),
      };
  }
  if (row.kind === 'pull_request') {
    const url = typeof payload.url === 'string' ? payload.url : '';
    const title =
      typeof payload.title === 'string' && payload.title.trim() !== ''
        ? payload.title.trim()
        : null;
    return {
      ...common,
      kind: 'pull_request',
      number: Number(/\/pull\/(\d+)$/.exec(url)?.[1] ?? 0),
      title,
      url,
    };
  }
  return { ...common, kind: 'plan' };
}

const deliveryRecordKinds = [
  'plan',
  'checks',
  'pull_request',
  'review',
  'rework_started',
  'blocked',
  'sent_back',
  'returned_to_design',
  'merged',
] as const;

/**
 * The pull request a builder continues (spec §4.4): the item's newest pull_request record, unless
 * the item has since returned to design, which ends it. Null when there is none.
 */
export async function livePullRequest(
  database: DatabaseExecutor,
  itemId: string,
): Promise<LivePullRequest | null> {
  const row = await database
    .selectFrom('work_item_records')
    .select(['kind', 'payload'])
    .where('work_item_id', '=', itemId)
    .where('kind', 'in', ['pull_request', 'returned_to_design'])
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (row?.kind !== 'pull_request') return null;
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const url = typeof payload.url === 'string' ? payload.url : '';
  return {
    branch: typeof payload.branch === 'string' ? payload.branch : '',
    head: typeof payload.head === 'string' ? payload.head : '',
    number: Number(/\/pull\/(\d+)$/.exec(url)?.[1] ?? 0),
    url,
  };
}

/**
 * The block the item waits on now: its newest blocked record, written in the same transaction as
 * the move into `waiting` that the item is still in.
 */
async function deliveryBlocked(
  database: Kysely<Database>,
  itemId: string,
): Promise<DeliveryBlocked | null> {
  const item = await database
    .selectFrom('work_items')
    .innerJoin('projects', 'projects.id', 'work_items.project_id')
    .select(['work_items.state', 'projects.design_enabled'])
    .where('work_items.id', '=', itemId)
    .executeTakeFirstOrThrow();
  if (item.state !== 'waiting') return null;
  const entered = await database
    .selectFrom('work_item_history')
    .select('created_at')
    .where('work_item_id', '=', itemId)
    .where('to_state', '=', 'waiting')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  const record = await database
    .selectFrom('work_item_records')
    .leftJoin('runs', 'runs.id', 'work_item_records.run_id')
    .select([
      'work_item_records.id',
      'work_item_records.created_at',
      'work_item_records.kind',
      'work_item_records.payload',
      'work_item_records.run_id',
      'runs.agent_name',
    ])
    .where('work_item_records.work_item_id', '=', itemId)
    .where('work_item_records.kind', '=', 'blocked')
    .orderBy('work_item_records.id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (
    entered === undefined ||
    record === undefined ||
    record.created_at.getTime() < entered.created_at.getTime()
  ) {
    return null;
  }
  return {
    canReturnToDesign: item.design_enabled,
    event: toDeliveryEvent(record) as DeliveryBlocked['event'],
  };
}

/** Answers the item's wait as the navigator, refusing once it no longer waits. */
async function answerBlocked(
  database: Kysely<Database>,
  itemId: string,
  decide: (
    current: LockedWorkItem,
  ) => TransitionRequest | Extract<AnswerResult, { ok: false }>,
): Promise<AnswerResult> {
  return transitionLocked(database, itemId, (current) =>
    current.item.state === 'waiting'
      ? decide(current)
      : {
          code: 'not_waiting' as const,
          ok: false as const,
          reason: 'This item is no longer waiting for you.',
        },
  );
}

async function deliveryCurrent(
  database: Kysely<Database>,
  itemId: string,
): Promise<DeliveryCurrent> {
  const item = await database
    .selectFrom('work_items')
    .leftJoin('runs', 'runs.id', 'work_items.holder_run_id')
    .select(['work_items.project_id', 'work_items.state', 'runs.agent_name'])
    .where('work_items.id', '=', itemId)
    .executeTakeFirstOrThrow();
  if (item.state === 'merging') {
    return { kind: 'waiting_for_checks' };
  }
  if (item.state === 'reviewing' && item.agent_name !== null) {
    return { kind: 'waiting_for_review', reviewer: item.agent_name };
  }
  if (item.state !== 'review_ready' && item.state !== 'reviewing') {
    return null;
  }
  const reviewer = await database
    .selectFrom('agents')
    .innerJoin('agent_types', 'agent_types.id', 'agents.agent_type_id')
    .select('agents.name')
    .where('agents.project_id', '=', item.project_id)
    .where('agents.enabled', '=', true)
    .where('agent_types.role', '=', 'reviewer')
    .orderBy('agents.created_sequence')
    .limit(1)
    .executeTakeFirst();
  return { kind: 'waiting_for_review', reviewer: reviewer?.name ?? null };
}

/**
 * Appends a record to the item a run holds while building (spec §4.11), under the row lock, so a
 * plan or checks report can only come from the run that holds the item right now.
 */
export async function recordForHeldItem(
  database: Kysely<Database>,
  itemId: string,
  runId: string,
  record: Readonly<Record<string, unknown>> & { readonly kind: string },
): Promise<
  | { readonly ok: true }
  | {
      readonly code: 'nothing_held' | 'refused';
      readonly ok: false;
      readonly reason: string;
    }
> {
  return database.transaction().execute(async (transaction) => {
    const { item } = await getLockedItem(transaction, itemId);
    if (item.holderRunId !== runId) {
      return {
        code: 'nothing_held' as const,
        ok: false as const,
        reason: 'This run no longer holds its work item.',
      };
    }
    if (item.state !== 'building') {
      return {
        code: 'refused' as const,
        ok: false as const,
        reason: `A ${record.kind} is recorded while building; this item is ${item.state}.`,
      };
    }
    await transaction
      .insertInto('work_item_records')
      .values({
        kind: record.kind,
        payload: JSON.stringify(record),
        run_id: runId,
        work_item_id: itemId,
      })
      .execute();
    return { ok: true as const };
  });
}

/**
 * Gives back the item a run held when it ended (spec §4.5), inside the caller's transaction: to
 * its queue, or to the navigator once `max_attempts` is reached, with the run's last assistant
 * message as a comment. Returns the item's new state, or `null` when the run held nothing.
 */
export async function releaseHeldItem(
  database: Transaction<Database>,
  runId: string,
  options: { readonly lastMessage: string | null; readonly reason: string },
): Promise<WorkItemState | null> {
  const held = await database
    .selectFrom('work_items')
    .innerJoin('projects', 'projects.id', 'work_items.project_id')
    .select(['work_items.id', 'projects.max_attempts'])
    .where('work_items.holder_run_id', '=', runId)
    .executeTakeFirst();
  if (held === undefined) {
    return null;
  }
  const current = await getLockedItem(database, held.id);
  const ended = runEndedRequest(current.item, {
    maxAttempts: held.max_attempts,
    reason: options.reason,
  });
  // A builder that runs out of attempts is a block the navigator answers from the item (spec §4.5).
  const request: TransitionRequest =
    ended.waiting !== undefined && current.item.state === 'building'
      ? {
          ...ended,
          record: {
            count: current.item.attempts + 1,
            kind: 'blocked',
            reason: 'too_many_attempts',
          },
          waiting: {
            ...ended.waiting,
            reason: blockedHeading({ reason: 'too_many_attempts' }),
          },
        }
      : ended;
  const result = transition(current.item, request, current.context);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  await persistTransition(database, held.id, current.item, result, request);
  const comment = options.lastMessage?.trim() ?? '';
  if (comment !== '') {
    await database
      .insertInto('work_item_comments')
      .values({ body: comment, work_item_id: held.id })
      .execute();
  }
  return result.item.state;
}

async function getLockedItem(
  database: DatabaseExecutor,
  itemId: string,
): Promise<{ readonly context: LifecycleContext; readonly item: WorkItem }> {
  await assertWorkItemExists(database, itemId);
  const row = await database
    .selectFrom('work_items')
    .innerJoin('projects', 'projects.id', 'work_items.project_id')
    .select([
      'work_items.attempts',
      'work_items.holder_run_id',
      'work_items.priority',
      'work_items.rounds',
      'work_items.state',
      'work_items.waiting_kind',
      'work_items.waiting_reason',
      'work_items.return_state',
      'projects.design_enabled',
      'projects.grooming_enabled',
      'projects.max_rounds',
      'projects.verify_enabled',
    ])
    .where('work_items.id', '=', itemId)
    .forUpdate()
    .executeTakeFirst();

  if (row === undefined) {
    throw new WorkItemNotFoundError(itemId);
  }

  const build =
    row.state === 'building' && row.holder_run_id !== null
      ? await buildEvidenceOf(database, itemId, row.holder_run_id)
      : undefined;

  return {
    item: {
      attempts: row.attempts,
      holderRunId: row.holder_run_id,
      priority: row.priority,
      rounds: row.rounds,
      state: row.state,
      waitingKind: row.waiting_kind,
      waitingReason: row.waiting_reason,
      returnState: row.return_state,
      ...(build === undefined ? {} : { build }),
    },
    context: {
      stages: {
        design: row.design_enabled,
        grooming: row.grooming_enabled,
        verify: row.verify_enabled,
      },
      maxRounds: row.max_rounds,
      supportsSplitting: false,
    },
  };
}

/** What the holding run has recorded on the item: a plan, and its newest checks report. */
async function buildEvidenceOf(
  database: DatabaseExecutor,
  itemId: string,
  runId: string,
): Promise<BuildEvidence> {
  const rows = await database
    .selectFrom('work_item_records')
    .select(['kind', 'payload'])
    .where('work_item_id', '=', itemId)
    .where('run_id', '=', runId)
    .where('kind', 'in', ['plan', 'checks'])
    .orderBy('id', 'desc')
    .execute();
  const checks = rows.find((row) => row.kind === 'checks');
  const passed =
    checks === undefined
      ? null
      : (checks.payload as { passed?: unknown } | null)?.passed === true
        ? 'passed'
        : 'failed';
  return {
    checks: passed,
    planRecorded: rows.some((row) => row.kind === 'plan'),
  };
}

async function persistTransition(
  database: DatabaseExecutor,
  itemId: string,
  current: WorkItem,
  result: Extract<TransitionResult, { readonly ok: true }>,
  request: TransitionRequest,
): Promise<void> {
  await database
    .updateTable('work_items')
    .set({
      attempts: result.item.attempts,
      holder_run_id: result.item.holderRunId,
      priority: result.item.priority,
      rounds: result.item.rounds,
      state: result.item.state,
      waiting_kind: result.item.waitingKind,
      waiting_reason: result.item.waitingReason,
      return_state: result.item.returnState,
      updated_at: new Date(),
    })
    .where('id', '=', itemId)
    .execute();

  // A run's cost belongs to the item it held (spec §10): its first claim names it for good.
  const holder = result.item.holderRunId;
  if (holder !== null && holder !== current.holderRunId) {
    await database
      .updateTable('runs')
      .set({ work_item_id: itemId })
      .where('id', '=', holder)
      .where('work_item_id', 'is', null)
      .execute();
  }

  await database
    .insertInto('work_item_history')
    .values({
      work_item_id: itemId,
      from_state: current.state,
      to_state: result.item.state,
      actor_role: request.actor.role,
      actor_run_id: request.actor.runId ?? null,
      reason: request.reason ?? null,
    })
    .execute();

  await database
    .insertInto('lifecycle_events')
    .values({
      work_item_id: itemId,
      kind: 'transition',
      payload: JSON.stringify({
        from: current.state,
        to: result.item.state,
      }),
    })
    .execute();

  for (const effect of result.effects) {
    if (effect.kind === 'record') {
      await database
        .insertInto('work_item_records')
        .values({
          work_item_id: itemId,
          kind:
            typeof effect.record.kind === 'string'
              ? effect.record.kind
              : 'unspecified',
          payload: JSON.stringify(effect.record),
          run_id: request.actor.runId ?? null,
        })
        .execute();
    }
  }
}

function workingStateFor(role: RunRole): WorkItemState {
  const stateByRole: Record<RunRole, WorkItemState> = {
    builder: 'building',
    designer: 'designing',
    groomer: 'grooming',
    reviewer: 'reviewing',
    verifier: 'verifying',
  };

  return stateByRole[role];
}
