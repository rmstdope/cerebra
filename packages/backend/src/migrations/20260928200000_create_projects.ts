import { type Kysely } from 'kysely';

import type { Database } from '../database.js';

export async function up(database: Kysely<Database>): Promise<void> {
  await database.schema
    .alterTable('projects')
    .addColumn('remote', 'text')
    .addColumn('owner', 'text')
    .addColumn('default_branch', 'text')
    .addColumn('key_prefix', 'text')
    .addColumn('github_token_ciphertext', 'text')
    .addColumn('github_token_iv', 'text')
    .addColumn('github_token_tag', 'text')
    .addColumn('max_concurrent_runs', 'integer', (column) =>
      column.notNull().defaultTo(1),
    )
    .addColumn('max_attempts', 'integer', (column) =>
      column.notNull().defaultTo(3),
    )
    .addColumn('max_rounds', 'integer', (column) =>
      column.notNull().defaultTo(5),
    )
    .execute();
}

export async function down(database: Kysely<Database>): Promise<void> {
  await database.schema
    .alterTable('projects')
    .dropColumn('github_token_tag')
    .dropColumn('github_token_iv')
    .dropColumn('github_token_ciphertext')
    .dropColumn('key_prefix')
    .dropColumn('default_branch')
    .dropColumn('owner')
    .dropColumn('remote')
    .dropColumn('max_rounds')
    .dropColumn('max_attempts')
    .dropColumn('max_concurrent_runs')
    .execute();
}
