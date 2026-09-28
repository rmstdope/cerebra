import type { Kysely, Transaction } from 'kysely';

import type { Database } from './database.js';
import {
  createWorkItem,
  transition,
  type LifecycleContext,
  type LifecycleRole,
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
  readonly id: string;
  readonly priority?: WorkItem['priority'];
  readonly projectId: string;
  readonly state?: WorkItemState;
}

export interface Board {
  claim(itemId: string, role: RunRole): Promise<TransitionResult>;
  createProject(input: CreateProject): Promise<void>;
  createWorkItem(input: CreateWorkItem): Promise<void>;
  transition(
    itemId: string,
    request: TransitionRequest,
  ): Promise<TransitionResult>;
}

export function createBoard(database: Kysely<Database>): Board {
  return {
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

    async createWorkItem({ id, projectId, priority, state = 'new' }) {
      const item = createWorkItem({ priority, state });

      await database
        .insertInto('work_items')
        .values({
          id,
          project_id: projectId,
          state: item.state,
          priority: item.priority,
          holder_run_id: item.holderRunId,
          waiting_kind: item.waitingKind,
          waiting_reason: item.waitingReason,
          return_state: item.returnState,
          attempts: item.attempts,
          rounds: item.rounds,
        })
        .execute();
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

async function getLockedItem(
  database: DatabaseExecutor,
  itemId: string,
): Promise<{ readonly context: LifecycleContext; readonly item: WorkItem }> {
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
    throw new Error(`Work item ${itemId} does not exist.`);
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
