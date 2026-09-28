import { sql, type Kysely } from 'kysely';

import type { Database } from '../database.js';

export async function up(database: Kysely<Database>): Promise<void> {
  await database.schema
    .createTable('projects')
    .addColumn('id', 'uuid', (column) => column.primaryKey())
    .addColumn('remote', 'text', (column) => column.notNull().unique())
    .addColumn('owner', 'text', (column) => column.notNull())
    .addColumn('name', 'text', (column) => column.notNull())
    .addColumn('default_branch', 'text', (column) => column.notNull())
    .addColumn('key_prefix', 'text', (column) => column.notNull().unique())
    .addColumn('github_token_ciphertext', 'text', (column) => column.notNull())
    .addColumn('github_token_iv', 'text', (column) => column.notNull())
    .addColumn('github_token_tag', 'text', (column) => column.notNull())
    .addColumn('grooming_enabled', 'boolean', (column) =>
      column.notNull().defaultTo(true),
    )
    .addColumn('design_enabled', 'boolean', (column) =>
      column.notNull().defaultTo(true),
    )
    .addColumn('verify_enabled', 'boolean', (column) =>
      column.notNull().defaultTo(true),
    )
    .addColumn('max_concurrent_runs', 'integer', (column) =>
      column.notNull().defaultTo(1),
    )
    .addColumn('max_attempts', 'integer', (column) =>
      column.notNull().defaultTo(3),
    )
    .addColumn('max_rounds', 'integer', (column) =>
      column.notNull().defaultTo(5),
    )
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();
}

export async function down(database: Kysely<Database>): Promise<void> {
  await database.schema.dropTable('projects').execute();
}
