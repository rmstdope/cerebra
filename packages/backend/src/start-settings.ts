import type { Kysely } from 'kysely';

import { ProjectNotFoundError } from './board.js';
import type { Database } from './database.js';
import { isUuid } from './runs.js';

export interface Limits {
  readonly instanceLimit: number;
  /** The project's own limit, or `null` when no project was asked about. */
  readonly projectLimit: number | null;
}

/** A limit the navigator entered that cannot be saved, with the words the form shows. */
export class LimitInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'LimitInputError';
  }
}

export const wholeNumberMessage = 'Enter a whole number of 1 or more.';

export function aboveCeilingMessage(instanceLimit: number): string {
  return `This can't be higher than the Cerebra-wide limit (${instanceLimit}).`;
}

/** The pause and the run limits that hold trigger-started runs back (spec §3, §5.4). */
export interface StartSettings {
  limits(projectId?: string): Promise<Limits>;
  setProjectLimit(projectId: string, value: unknown): Promise<Limits>;
  setInstanceLimit(value: unknown): Promise<Limits>;
  paused(projectId: string): Promise<boolean>;
  setPaused(projectId: string, paused: boolean): Promise<void>;
}

const largestLimit = 2_147_483_647;

function limitFrom(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > largestLimit
  ) {
    throw new LimitInputError(wholeNumberMessage);
  }
  return value;
}

export function createStartSettings(database: Kysely<Database>): StartSettings {
  async function instanceLimit(executor = database): Promise<number> {
    const row = await executor
      .selectFrom('instance_settings')
      .select('max_concurrent_runs')
      .executeTakeFirstOrThrow();
    return row.max_concurrent_runs;
  }

  async function project(projectId: string) {
    const row = isUuid(projectId)
      ? await database
          .selectFrom('projects')
          .select(['automatic_starts_paused', 'max_concurrent_runs'])
          .where('id', '=', projectId)
          .executeTakeFirst()
      : undefined;
    if (row === undefined) throw new ProjectNotFoundError(projectId);
    return row;
  }

  return {
    async limits(projectId) {
      return {
        instanceLimit: await instanceLimit(),
        projectLimit:
          projectId === undefined
            ? null
            : (await project(projectId)).max_concurrent_runs,
      };
    },

    async setProjectLimit(projectId, value) {
      const limit = limitFrom(value);
      await project(projectId);
      return database.transaction().execute(async (transaction) => {
        const ceiling = await transaction
          .selectFrom('instance_settings')
          .select('max_concurrent_runs')
          .forShare()
          .executeTakeFirstOrThrow();
        if (limit > ceiling.max_concurrent_runs) {
          throw new LimitInputError(
            aboveCeilingMessage(ceiling.max_concurrent_runs),
          );
        }
        await transaction
          .updateTable('projects')
          .set({ max_concurrent_runs: limit })
          .where('id', '=', projectId)
          .execute();
        return {
          instanceLimit: ceiling.max_concurrent_runs,
          projectLimit: limit,
        };
      });
    },

    async setInstanceLimit(value) {
      const limit = limitFrom(value);
      await database
        .updateTable('instance_settings')
        .set({ max_concurrent_runs: limit })
        .execute();
      return { instanceLimit: limit, projectLimit: null };
    },

    async paused(projectId) {
      return (await project(projectId)).automatic_starts_paused;
    },

    async setPaused(projectId, paused) {
      await project(projectId);
      await database
        .updateTable('projects')
        .set({ automatic_starts_paused: paused })
        .where('id', '=', projectId)
        .execute();
    },
  };
}
