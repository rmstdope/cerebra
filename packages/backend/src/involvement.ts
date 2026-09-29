import type { Kysely } from 'kysely';

import { ProjectNotFoundError } from './board.js';
import type { Database } from './database.js';
import { isUuid } from './runs.js';

/** How closely the navigator follows a project's builders (spec §4.9, D32). */
export type Involvement = 'autonomous' | 'plan' | 'full';

export const involvements: readonly Involvement[] = [
  'autonomous',
  'plan',
  'full',
];

export interface InvolvementSetting {
  readonly involvement: Involvement;
  /** The GitHub login whose pull-request review counts under `full` (D33). */
  readonly reviewAccount: string | null;
}

/** A setting the navigator entered that cannot be saved, with the words the form shows. */
export class InvolvementInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvolvementInputError';
  }
}

export const missingAccountMessage =
  'Enter the GitHub account whose review counts.';
const invalidAccountMessage = 'Enter a GitHub account name, like octocat.';
const invalidInvolvementMessage =
  'Choose Autonomous, Approve plans, or Approve plans and code.';

const githubLogin = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export interface InvolvementSettings {
  get(projectId: string): Promise<InvolvementSetting>;
  set(projectId: string, input: unknown): Promise<InvolvementSetting>;
}

function isInvolvement(value: unknown): value is Involvement {
  return involvements.includes(value as Involvement);
}

function settingFrom(input: unknown): InvolvementSetting {
  if (typeof input !== 'object' || input === null) {
    throw new InvolvementInputError(invalidInvolvementMessage);
  }
  const { involvement, reviewAccount } = input as Record<string, unknown>;
  if (!isInvolvement(involvement)) {
    throw new InvolvementInputError(invalidInvolvementMessage);
  }
  if (
    reviewAccount !== null &&
    reviewAccount !== undefined &&
    typeof reviewAccount !== 'string'
  ) {
    throw new InvolvementInputError(invalidAccountMessage);
  }
  const account = (reviewAccount ?? '').trim().replace(/^@/, '');
  if (account === '') {
    if (involvement === 'full') {
      throw new InvolvementInputError(missingAccountMessage);
    }
    return { involvement, reviewAccount: null };
  }
  if (!githubLogin.test(account)) {
    throw new InvolvementInputError(invalidAccountMessage);
  }
  return { involvement, reviewAccount: account };
}

export function createInvolvementSettings(
  database: Kysely<Database>,
): InvolvementSettings {
  return {
    async get(projectId) {
      const row = isUuid(projectId)
        ? await database
            .selectFrom('projects')
            .select(['involvement', 'review_account'])
            .where('id', '=', projectId)
            .executeTakeFirst()
        : undefined;
      if (row === undefined) throw new ProjectNotFoundError(projectId);
      return {
        involvement: row.involvement as Involvement,
        reviewAccount: row.review_account,
      };
    },

    async set(projectId, input) {
      const setting = settingFrom(input);
      const updated = isUuid(projectId)
        ? await database
            .updateTable('projects')
            .set({
              involvement: setting.involvement,
              review_account: setting.reviewAccount,
            })
            .where('id', '=', projectId)
            .executeTakeFirst()
        : undefined;
      if (updated === undefined || updated.numUpdatedRows === 0n) {
        throw new ProjectNotFoundError(projectId);
      }
      return setting;
    },
  };
}
