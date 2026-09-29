import {
  sql,
  type Kysely,
  type SelectQueryBuilder,
  type Transaction,
} from 'kysely';

import type { Database } from './database.js';
import {
  createWorkItem,
  transition,
  type LifecycleContext,
  type LifecycleRole,
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
  readonly id: string;
  readonly priority?: WorkItem['priority'];
  readonly projectId: string;
  readonly state?: WorkItemState;
  readonly title?: string;
}

export interface BoardWorkItem {
  readonly createdAt: Date;
  readonly description: string;
  readonly id: string;
  readonly priority: WorkItem['priority'];
  readonly state: WorkItemState;
  readonly title: string;
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

export interface BoardPage {
  readonly items: readonly BoardWorkItem[];
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
  createWorkItem(input: CreateWorkItem): Promise<void>;
  getHistory(itemId: string): Promise<readonly BoardHistoryEntry[]>;
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
      id,
      projectId,
      priority,
      state = 'new',
      title = '',
      description = '',
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
          })
          .execute();
      });
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

      return {
        items: page.slice(0, limit).map(toBoardWorkItem),
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
      return database.transaction().execute(async (transactionDatabase) => {
        const current = await getLockedItem(transactionDatabase, itemId);
        const runId = crypto.randomUUID();
        const result = transition(
          current.item,
          {
            actor: { role: 'backend', runId },
            record: { kind: 'claim', role },
            to: workingStateFor(role),
          },
          current.context,
        );

        if (!result.ok) {
          return result;
        }

        await transactionDatabase
          .insertInto('runs')
          .values({ id: runId, role, status: 'active' })
          .execute();
        await persistTransition(
          transactionDatabase,
          itemId,
          current.item,
          result,
          { actor: { role: 'backend', runId }, to: result.item.state },
        );
        return result;
      });
    },
  };
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

const boardColumns = [
  'created_at',
  'description',
  'id',
  'priority',
  'state',
  'title',
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
  readonly priority: WorkItem['priority'];
  readonly state: WorkItemState;
  readonly title: string;
  readonly updated_at: Date;
}): BoardWorkItem {
  return {
    createdAt: row.created_at,
    description: row.description,
    id: row.id,
    priority: row.priority,
    state: row.state,
    title: row.title,
    updatedAt: row.updated_at,
  };
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
      'projects.verify_enabled',
    ])
    .where('work_items.id', '=', itemId)
    .forUpdate()
    .executeTakeFirst();

  if (row === undefined) {
    throw new WorkItemNotFoundError(itemId);
  }

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
    },
    context: {
      stages: {
        design: row.design_enabled,
        grooming: row.grooming_enabled,
        verify: row.verify_enabled,
      },
      supportsSplitting: false,
    },
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
