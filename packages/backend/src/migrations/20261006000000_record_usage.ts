import { sql, type Kysely } from 'kysely';

import type { Database } from '../database.js';

/**
 * Usage and its attribution (spec §10, D39), and the per-project mute (spec §4.8, D40): each run
 * names the item it held, tokens are kept by model, and a project can silence its browser alerts.
 */
export async function up(database: Kysely<Database>): Promise<void> {
  await database.schema
    .alterTable('runs')
    .addColumn('work_item_id', 'uuid', (column) =>
      column.references('work_items.id').onDelete('set null'),
    )
    .execute();
  // A run that already ended names its item only through the history its claim wrote.
  await sql`
    update runs set work_item_id = coalesce(
      (select id from work_items where work_items.holder_run_id = runs.id),
      (select work_item_id from work_item_history
        where work_item_history.actor_run_id = runs.id
        order by work_item_history.id limit 1)
    )
  `.execute(database);
  await database.schema
    .createIndex('runs_work_item_id')
    .on('runs')
    .column('work_item_id')
    .execute();

  await database.schema
    .createTable('run_model_usage')
    .addColumn('run_id', 'uuid', (column) =>
      column.notNull().references('runs.id').onDelete('cascade'),
    )
    .addColumn('model', 'text', (column) => column.notNull())
    .addColumn('input_tokens', 'bigint', (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn('output_tokens', 'bigint', (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn('cache_read_tokens', 'bigint', (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn('cache_write_tokens', 'bigint', (column) =>
      column.notNull().defaultTo(0),
    )
    .addPrimaryKeyConstraint('run_model_usage_pkey', ['run_id', 'model'])
    .execute();

  await database.schema
    .alterTable('projects')
    .addColumn('browser_notifications', 'boolean', (column) =>
      column.notNull().defaultTo(true),
    )
    .execute();
}

export async function down(database: Kysely<Database>): Promise<void> {
  await database.schema
    .alterTable('projects')
    .dropColumn('browser_notifications')
    .execute();
  await database.schema.dropTable('run_model_usage').execute();
  await database.schema.dropIndex('runs_work_item_id').execute();
  await database.schema.alterTable('runs').dropColumn('work_item_id').execute();
}
