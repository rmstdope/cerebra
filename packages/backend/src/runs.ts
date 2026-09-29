import type { AgentEvent, Usage } from '@cerebra/shared';
import { sql, type Kysely } from 'kysely';

import type { AgentRole } from './agent-types.js';
import { releaseHeldItem } from './board.js';
import { liveRunStates, type Database, type RunState } from './database.js';

type RunRole = Database['runs']['role'];

export interface RunRecord {
  readonly agentId: string | null;
  readonly agentName: string | null;
  readonly containerId: string | null;
  readonly endedAt: Date | null;
  readonly failure: string | null;
  readonly id: string;
  readonly projectId: string | null;
  readonly role: RunRole;
  readonly startFailed: boolean;
  readonly startedAt: Date;
  readonly state: RunState;
}

export interface RunEventRecord {
  readonly createdAt: Date;
  readonly event: AgentEvent;
  readonly position: number;
}

export interface Conversation {
  readonly events: readonly RunEventRecord[];
  readonly run: RunRecord & {
    readonly agentRole: AgentRole | null;
    readonly item: { readonly id: string; readonly title: string } | null;
  };
}

export type EndedRunState = Extract<RunState, 'finished' | 'failed'>;

export interface EndRun {
  readonly failure?: string;
  /** Why a held item goes back, recorded in its history (spec §4.5). */
  readonly reason: string;
  readonly startFailed?: boolean;
  readonly state: EndedRunState;
}

export interface RunStore {
  create(input: {
    readonly agentId: string;
    readonly agentName: string;
    readonly projectId: string;
    readonly role: RunRole;
    readonly tokenHash: string;
  }): Promise<RunRecord>;
  setContainer(runId: string, containerId: string): Promise<void>;
  append(runId: string, event: AgentEvent): Promise<RunEventRecord>;
  /** Moves a live run between live states; `false` once it has ended. */
  setState(
    runId: string,
    state: Extract<RunState, 'active' | 'awaiting_input'>,
  ): Promise<boolean>;
  /** Adds one result's spending to the run as it arrives, so a later failure loses none of it. */
  addUsage(
    runId: string,
    usage: Usage & { readonly sessionId?: string },
  ): Promise<void>;
  /** Ends a live run and gives back what it held, in one transaction; `false` if it had ended. */
  end(runId: string, ending: EndRun): Promise<boolean>;
  read(runId: string): Promise<Conversation | null>;
  get(runId: string): Promise<RunRecord | null>;
  byTokenHash(tokenHash: string): Promise<RunRecord | null>;
  liveFor(agentId: string): Promise<RunRecord | null>;
  live(): Promise<readonly RunRecord[]>;
}

const runColumns = [
  'runs.agent_id',
  'runs.agent_name',
  'runs.container_id',
  'runs.created_at',
  'runs.ended_at',
  'runs.failure',
  'runs.id',
  'runs.project_id',
  'runs.role',
  'runs.start_failed',
  'runs.status',
] as const;

interface RunRow {
  readonly agent_id: string | null;
  readonly agent_name: string | null;
  readonly container_id: string | null;
  readonly created_at: Date;
  readonly ended_at: Date | null;
  readonly failure: string | null;
  readonly id: string;
  readonly project_id: string | null;
  readonly role: RunRole;
  readonly start_failed: boolean;
  readonly status: RunState;
}

function toRun(row: RunRow): RunRecord {
  return {
    agentId: row.agent_id,
    agentName: row.agent_name,
    containerId: row.container_id,
    endedAt: row.ended_at,
    failure: row.failure,
    id: row.id,
    projectId: row.project_id,
    role: row.role,
    startFailed: row.start_failed,
    startedAt: row.created_at,
    state: row.status,
  };
}

export function createRunStore(database: Kysely<Database>): RunStore {
  const selectRun = () => database.selectFrom('runs').select(runColumns);

  return {
    async create({ agentId, agentName, projectId, role, tokenHash }) {
      const row = await database
        .insertInto('runs')
        .values({
          agent_id: agentId,
          agent_name: agentName,
          id: crypto.randomUUID(),
          project_id: projectId,
          role,
          status: 'starting',
          token_hash: tokenHash,
        })
        .returning(runColumns)
        .executeTakeFirstOrThrow();
      return toRun(row);
    },

    async setContainer(runId, containerId) {
      await database
        .updateTable('runs')
        .set({ container_id: containerId })
        .where('id', '=', runId)
        .execute();
    },

    async append(runId, event) {
      return database.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom('runs')
          .select('id')
          .where('id', '=', runId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const last = await transaction
          .selectFrom('run_events')
          .select(sql<number>`coalesce(max(position), 0)::int`.as('position'))
          .where('run_id', '=', runId)
          .executeTakeFirstOrThrow();
        const row = await transaction
          .insertInto('run_events')
          .values({
            event: JSON.stringify(event),
            position: last.position + 1,
            run_id: runId,
          })
          .returning(['created_at', 'position'])
          .executeTakeFirstOrThrow();
        return { createdAt: row.created_at, event, position: row.position };
      });
    },

    async setState(runId, state) {
      const result = await database
        .updateTable('runs')
        .set({ status: state })
        .where('id', '=', runId)
        .where('status', 'in', liveRunStates)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },

    async addUsage(runId, { costUsd, models, sessionId }) {
      await database.transaction().execute(async (transaction) => {
        await transaction
          .updateTable('runs')
          .set({
            cost_usd: sql`cost_usd + ${costUsd}`,
            ...(sessionId === undefined ? {} : { session_id: sessionId }),
          })
          .where('id', '=', runId)
          .execute();
        const rows = Object.entries(models).map(([model, tokens]) => ({
          cache_read_tokens: String(tokens.cacheReadInputTokens),
          cache_write_tokens: String(tokens.cacheCreationInputTokens),
          input_tokens: String(tokens.inputTokens),
          model,
          output_tokens: String(tokens.outputTokens),
          run_id: runId,
        }));
        if (rows.length === 0) return;
        await transaction
          .insertInto('run_model_usage')
          .values(rows)
          .onConflict((conflict) =>
            conflict.columns(['run_id', 'model']).doUpdateSet({
              cache_read_tokens: sql`run_model_usage.cache_read_tokens + excluded.cache_read_tokens`,
              cache_write_tokens: sql`run_model_usage.cache_write_tokens + excluded.cache_write_tokens`,
              input_tokens: sql`run_model_usage.input_tokens + excluded.input_tokens`,
              output_tokens: sql`run_model_usage.output_tokens + excluded.output_tokens`,
            }),
          )
          .execute();
      });
    },

    async end(runId, ending) {
      return database.transaction().execute(async (transaction) => {
        const run = await transaction
          .selectFrom('runs')
          .select('status')
          .where('id', '=', runId)
          .forUpdate()
          .executeTakeFirst();
        if (
          run === undefined ||
          !(liveRunStates as readonly RunState[]).includes(run.status)
        ) {
          return false;
        }
        const last = await transaction
          .selectFrom('run_events')
          .select(sql<string>`event->>'text'`.as('text'))
          .where('run_id', '=', runId)
          .where(sql<boolean>`event->>'kind' = 'message'`)
          .where(sql<boolean>`event->>'parentToolCallId' IS NULL`)
          .orderBy('position', 'desc')
          .limit(1)
          .executeTakeFirst();
        await releaseHeldItem(transaction, runId, {
          lastMessage: last?.text ?? null,
          reason: ending.reason,
        });
        await transaction
          .updateTable('runs')
          .set({
            ended_at: sql`now()`,
            failure: ending.failure ?? null,
            start_failed: ending.startFailed ?? false,
            status: ending.state,
          })
          .where('id', '=', runId)
          .execute();
        return true;
      });
    },

    async read(runId) {
      if (!isUuid(runId)) {
        return null;
      }
      const row = await database
        .selectFrom('runs')
        .leftJoin('agents', 'agents.id', 'runs.agent_id')
        .leftJoin('agent_types', 'agent_types.id', 'agents.agent_type_id')
        .leftJoin('work_items', 'work_items.holder_run_id', 'runs.id')
        .select([
          ...runColumns,
          'agent_types.role as agent_role',
          'work_items.id as item_id',
          'work_items.title as item_title',
        ])
        .where('runs.id', '=', runId)
        .executeTakeFirst();
      if (row === undefined) {
        return null;
      }
      // Once released, the item is the one this run's history names first: its claim.
      const item =
        row.item_id !== null && row.item_title !== null
          ? { id: row.item_id, title: row.item_title }
          : ((await database
              .selectFrom('work_item_history')
              .innerJoin(
                'work_items',
                'work_items.id',
                'work_item_history.work_item_id',
              )
              .select(['work_items.id', 'work_items.title'])
              .where('work_item_history.actor_run_id', '=', runId)
              .orderBy('work_item_history.id')
              .limit(1)
              .executeTakeFirst()) ?? null);
      const events = await database
        .selectFrom('run_events')
        .select(['created_at', 'event', 'position'])
        .where('run_id', '=', runId)
        .orderBy('position')
        .execute();
      return {
        events: events.map((event) => ({
          createdAt: event.created_at,
          event: event.event as AgentEvent,
          position: event.position,
        })),
        run: {
          ...toRun(row),
          agentRole:
            row.agent_role ?? (row.role === 'assistant' ? 'assistant' : null),
          item,
        },
      };
    },

    async get(runId) {
      if (!isUuid(runId)) {
        return null;
      }
      const row = await selectRun().where('id', '=', runId).executeTakeFirst();
      return row === undefined ? null : toRun(row);
    },

    async byTokenHash(tokenHash) {
      const row = await selectRun()
        .where('token_hash', '=', tokenHash)
        .where('status', 'in', liveRunStates)
        .executeTakeFirst();
      return row === undefined ? null : toRun(row);
    },

    async liveFor(agentId) {
      const row = await selectRun()
        .where('agent_id', '=', agentId)
        .where('status', 'in', liveRunStates)
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      return row === undefined ? null : toRun(row);
    },

    async live() {
      const rows = await selectRun()
        .where('status', 'in', liveRunStates)
        .orderBy('created_at')
        .execute();
      return rows.map(toRun);
    },
  };
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return uuid.test(value);
}
