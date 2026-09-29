import type { Kysely } from 'kysely';

import { ProjectNotFoundError, WorkItemNotFoundError } from './board.js';
import type { Database, RunState } from './database.js';
import { isUuid } from './runs.js';

type RunRole = Database['runs']['role'];

export interface RunCost {
  readonly agentName: string | null;
  readonly costUsd: number;
  readonly id: string;
  readonly role: RunRole;
  readonly startedAt: Date;
  readonly state: RunState;
}

export interface ItemCost {
  readonly runs: readonly RunCost[];
  readonly totalUsd: number;
}

export interface ProjectRunCost extends RunCost {
  readonly item: { readonly id: string; readonly title: string } | null;
}

export interface ProjectCost {
  readonly notLinkedUsd: number;
  readonly runs: readonly ProjectRunCost[];
  readonly totalUsd: number;
  readonly workItemsUsd: number;
}

/** Reads what work has cost: every total is a sum over the runs that did it (spec §10). */
export interface CostReader {
  forItem(itemId: string): Promise<ItemCost>;
  forProject(projectId: string): Promise<ProjectCost>;
}

const runCostColumns = [
  'runs.agent_name',
  'runs.cost_usd',
  'runs.created_at',
  'runs.id',
  'runs.role',
  'runs.status',
] as const;

function toRunCost(row: {
  readonly agent_name: string | null;
  readonly cost_usd: number;
  readonly created_at: Date;
  readonly id: string;
  readonly role: RunRole;
  readonly status: RunState;
}): RunCost {
  return {
    agentName: row.agent_name,
    costUsd: row.cost_usd,
    id: row.id,
    role: row.role,
    startedAt: row.created_at,
    state: row.status,
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function createCostReader(database: Kysely<Database>): CostReader {
  return {
    async forItem(itemId) {
      const item = isUuid(itemId)
        ? await database
            .selectFrom('work_items')
            .select('id')
            .where('id', '=', itemId)
            .executeTakeFirst()
        : undefined;
      if (item === undefined) {
        throw new WorkItemNotFoundError(itemId);
      }
      const rows = await database
        .selectFrom('runs')
        .select(runCostColumns)
        .where('runs.work_item_id', '=', itemId)
        .orderBy('runs.created_at', 'desc')
        .orderBy('runs.id')
        .execute();
      const runs = rows.map(toRunCost);
      return { runs, totalUsd: sum(runs.map((run) => run.costUsd)) };
    },

    async forProject(projectId) {
      const project = isUuid(projectId)
        ? await database
            .selectFrom('projects')
            .select('id')
            .where('id', '=', projectId)
            .executeTakeFirst()
        : undefined;
      if (project === undefined) {
        throw new ProjectNotFoundError(projectId);
      }
      const rows = await database
        .selectFrom('runs')
        .leftJoin('work_items', 'work_items.id', 'runs.work_item_id')
        .select([
          ...runCostColumns,
          'work_items.id as item_id',
          'work_items.title as item_title',
        ])
        .where('runs.project_id', '=', projectId)
        .orderBy('runs.created_at', 'desc')
        .orderBy('runs.id')
        .execute();
      const runs = rows.map((row) => ({
        ...toRunCost(row),
        item:
          row.item_id !== null && row.item_title !== null
            ? { id: row.item_id, title: row.item_title }
            : null,
      }));
      const workItemsUsd = sum(
        runs.filter((run) => run.item !== null).map((run) => run.costUsd),
      );
      const notLinkedUsd = sum(
        runs.filter((run) => run.item === null).map((run) => run.costUsd),
      );
      return {
        notLinkedUsd,
        runs,
        totalUsd: workItemsUsd + notLinkedUsd,
        workItemsUsd,
      };
    },
  };
}
