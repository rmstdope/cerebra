import { sql, type Kysely } from 'kysely';

import type { Database } from '../database.js';

/**
 * How closely the navigator follows a project's builders (spec §4.9, D32, D33): the preset and the
 * GitHub account whose pull-request review counts under `full`.
 */
export async function up(database: Kysely<Database>): Promise<void> {
  await database.schema
    .alterTable('projects')
    .addColumn('involvement', 'text', (column) =>
      column.notNull().defaultTo('autonomous'),
    )
    .addColumn('review_account', 'text')
    .execute();
  await database.schema
    .alterTable('projects')
    .addCheckConstraint(
      'projects_involvement_check',
      sql`involvement IN ('autonomous', 'plan', 'full')`,
    )
    .execute();
  await database.schema
    .alterTable('projects')
    .addCheckConstraint(
      'projects_review_account_check',
      sql`involvement <> 'full' OR review_account IS NOT NULL`,
    )
    .execute();
}

export async function down(database: Kysely<Database>): Promise<void> {
  await database.schema
    .alterTable('projects')
    .dropConstraint('projects_review_account_check')
    .execute();
  await database.schema
    .alterTable('projects')
    .dropConstraint('projects_involvement_check')
    .execute();
  await database.schema
    .alterTable('projects')
    .dropColumn('review_account')
    .dropColumn('involvement')
    .execute();
}
