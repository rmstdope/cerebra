import { sql, type Kysely } from 'kysely';

import type { Database } from '../database.js';

/**
 * What the dispatcher needs (spec §3, §5.4; architecture §6): a per-project pause, the
 * Cerebra-wide run ceiling, and the log of every decision it makes.
 */
export async function up(database: Kysely<Database>): Promise<void> {
  await database.schema
    .createTable('instance_settings')
    .addColumn('id', 'boolean', (column) =>
      column
        .primaryKey()
        .defaultTo(true)
        .check(sql`id`),
    )
    .addColumn('max_concurrent_runs', 'integer', (column) =>
      column
        .notNull()
        .defaultTo(3)
        .check(sql`max_concurrent_runs >= 1`),
    )
    .execute();
  await database.insertInto('instance_settings').defaultValues().execute();

  await database
    .updateTable('projects')
    .set({
      max_concurrent_runs: sql`greatest(1, least(max_concurrent_runs, (select max_concurrent_runs from instance_settings)))`,
    })
    .execute();
  await database.schema
    .alterTable('projects')
    .addColumn('automatic_starts_paused', 'boolean', (column) =>
      column.notNull().defaultTo(false),
    )
    .execute();
  await database.schema
    .alterTable('projects')
    .addCheckConstraint(
      'projects_max_concurrent_runs_positive',
      sql`max_concurrent_runs >= 1`,
    )
    .execute();

  await database.schema
    .createTable('dispatch_log')
    .addColumn('id', 'bigserial', (column) => column.primaryKey())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn('project_id', 'uuid', (column) =>
      column.references('projects.id').onDelete('cascade'),
    )
    .addColumn('work_item_id', 'uuid', (column) =>
      column.references('work_items.id').onDelete('cascade'),
    )
    .addColumn('agent_id', 'uuid', (column) =>
      column.references('agents.id').onDelete('set null'),
    )
    .addColumn('run_id', 'uuid', (column) =>
      column.references('runs.id').onDelete('set null'),
    )
    .addColumn('decision', 'text', (column) =>
      column.notNull().check(sql`decision in ('started', 'refused')`),
    )
    .addColumn('reason', 'text', (column) => column.notNull())
    .execute();
}

export async function down(database: Kysely<Database>): Promise<void> {
  await database.schema.dropTable('dispatch_log').execute();
  await database.schema
    .alterTable('projects')
    .dropConstraint('projects_max_concurrent_runs_positive')
    .execute();
  await database.schema
    .alterTable('projects')
    .dropColumn('automatic_starts_paused')
    .execute();
  await database.schema.dropTable('instance_settings').execute();
}
