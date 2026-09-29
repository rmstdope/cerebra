import type { Kysely } from 'kysely';

import type { Database } from './database.js';
import { projectLabel, type NavigatorQueue } from './navigator-queue.js';

export type AttentionKind = 'question' | 'waiting' | 'trouble';

export interface AttentionEntry {
  readonly agentName: string | null;
  readonly id: string;
  readonly itemId: string | null;
  readonly kind: AttentionKind;
  readonly projectId: string;
  readonly projectName: string;
  /** The run to open for a question or trouble; null for waiting work. */
  readonly runId: string | null;
  readonly since: Date;
  readonly title: string;
}

/** What needs the navigator now: questions, waiting work and trouble, never new work (spec §4.8). */
export interface Attention {
  list(): Promise<readonly AttentionEntry[]>;
}

export const troubleTitle = 'A run stopped before it could finish';

/** Agents whose newest run failed; the trouble clears once the agent runs again or is removed. */
async function troubledRuns(
  database: Kysely<Database>,
): Promise<AttentionEntry[]> {
  const rows = await database
    .selectFrom('runs')
    .innerJoin('agents', 'agents.id', 'runs.agent_id')
    .innerJoin('projects', 'projects.id', 'agents.project_id')
    .select([
      'runs.id',
      'runs.agent_name',
      'runs.created_at',
      'runs.ended_at',
      'runs.status',
      'runs.work_item_id',
      'projects.id as project_id',
      'projects.name as project_name',
      'projects.owner as project_owner',
    ])
    .distinctOn('runs.agent_id')
    .orderBy('runs.agent_id')
    .orderBy('runs.created_at', 'desc')
    .orderBy('runs.id', 'desc')
    .execute();
  return rows
    .filter((row) => row.status === 'failed')
    .map((row) => ({
      agentName: row.agent_name,
      id: `trouble:${row.id}`,
      itemId: row.work_item_id,
      kind: 'trouble' as const,
      projectId: row.project_id,
      projectName: projectLabel(row.project_name, row.project_owner),
      runId: row.id,
      since: row.ended_at ?? row.created_at,
      title: troubleTitle,
    }));
}

export function createAttention(
  database: Kysely<Database>,
  queue: Pick<NavigatorQueue, 'list'>,
): Attention {
  return {
    async list() {
      const { entries } = await queue.list();
      const waiting = entries
        .filter((entry) => entry.kind !== 'new')
        .map((entry): AttentionEntry =>
          entry.run === null
            ? {
                agentName: entry.askedBy,
                id: entry.id,
                itemId: entry.id,
                kind: 'waiting',
                projectId: entry.projectId,
                projectName: entry.projectName,
                runId: null,
                since: entry.since,
                title: entry.title,
              }
            : {
                agentName: entry.askedBy,
                id: entry.id,
                itemId: null,
                kind: 'question',
                projectId: entry.projectId,
                projectName: entry.projectName,
                runId: entry.run.id,
                since: entry.since,
                title: entry.title,
              },
        );
      return [...waiting, ...(await troubledRuns(database))].sort(
        (a, b) =>
          b.since.getTime() - a.since.getTime() || a.id.localeCompare(b.id),
      );
    },
  };
}
