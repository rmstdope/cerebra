import { sql, type Kysely } from 'kysely';

import type { Database } from '../database.js';

const states = sql.raw(
  "'new', 'grooming_ready', 'grooming', 'design_ready', 'designing', 'build_ready', 'building', 'review_ready', 'reviewing', 'merging', 'verify_ready', 'verifying', 'waiting', 'split', 'done', 'cancelled'",
);

const workingStates = sql.raw(
  "'grooming', 'designing', 'building', 'reviewing', 'verifying'",
);

export async function up(database: Kysely<Database>): Promise<void> {
  await database.schema
    .createTable('projects')
    .addColumn('id', 'uuid', (column) => column.primaryKey())
    .addColumn('name', 'text', (column) => column.notNull())
    .addColumn('grooming_enabled', 'boolean', (column) =>
      column.notNull().defaultTo(true),
    )
    .addColumn('design_enabled', 'boolean', (column) =>
      column.notNull().defaultTo(true),
    )
    .addColumn('verify_enabled', 'boolean', (column) =>
      column.notNull().defaultTo(true),
    )
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await database.schema
    .createTable('runs')
    .addColumn('id', 'uuid', (column) => column.primaryKey())
    .addColumn('role', 'text', (column) => column.notNull())
    .addColumn('status', 'text', (column) =>
      column.notNull().defaultTo('active'),
    )
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint(
      'runs_role_check',
      sql`role IN ('groomer', 'designer', 'builder', 'reviewer', 'verifier')`,
    )
    .addCheckConstraint('runs_status_check', sql`status IN ('active', 'ended')`)
    .execute();

  await database.schema
    .createTable('work_items')
    .addColumn('id', 'uuid', (column) => column.primaryKey())
    .addColumn('project_id', 'uuid', (column) =>
      column.references('projects.id').onDelete('cascade').notNull(),
    )
    .addColumn('state', 'text', (column) => column.notNull())
    .addColumn('priority', 'text')
    .addColumn('holder_run_id', 'uuid', (column) =>
      column.references('runs.id').onDelete('restrict'),
    )
    .addColumn('waiting_kind', 'text')
    .addColumn('waiting_reason', 'text')
    .addColumn('return_state', 'text')
    .addColumn('attempts', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('rounds', 'integer', (column) => column.notNull().defaultTo(0))
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint('work_items_state_check', sql`state IN (${states})`)
    .addCheckConstraint(
      'work_items_holder_check',
      sql`(state IN (${workingStates})) = (holder_run_id IS NOT NULL)`,
    )
    .addCheckConstraint(
      'work_items_waiting_check',
      sql`(state = 'waiting') = (
        waiting_kind IS NOT NULL
        AND waiting_reason IS NOT NULL
        AND return_state IS NOT NULL
      )`,
    )
    .addCheckConstraint(
      'work_items_waiting_kind_check',
      sql`waiting_kind IS NULL OR waiting_kind IN ('question', 'escalation', 'code_review', 'merge')`,
    )
    .addCheckConstraint(
      'work_items_return_state_check',
      sql`return_state IS NULL OR return_state IN (${states})`,
    )
    .addCheckConstraint(
      'work_items_priority_check',
      sql`(state = 'new' AND priority IS NULL)
        OR state = 'cancelled'
        OR (state <> 'new' AND priority IN ('P0', 'P1', 'P2', 'P3'))`,
    )
    .addCheckConstraint('work_items_attempts_check', sql`attempts >= 0`)
    .addCheckConstraint('work_items_rounds_check', sql`rounds >= 0`)
    .execute();

  await database.schema
    .createIndex('work_items_holder_run_id_unique')
    .on('work_items')
    .column('holder_run_id')
    .unique()
    .execute();

  await database.schema
    .createTable('work_item_history')
    .addColumn('id', 'bigserial', (column) => column.primaryKey())
    .addColumn('work_item_id', 'uuid', (column) =>
      column.references('work_items.id').onDelete('cascade').notNull(),
    )
    .addColumn('from_state', 'text', (column) => column.notNull())
    .addColumn('to_state', 'text', (column) => column.notNull())
    .addColumn('actor_role', 'text', (column) => column.notNull())
    .addColumn('actor_run_id', 'uuid', (column) =>
      column.references('runs.id').onDelete('restrict'),
    )
    .addColumn('reason', 'text')
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint(
      'work_item_history_from_state_check',
      sql`from_state IN (${states})`,
    )
    .addCheckConstraint(
      'work_item_history_to_state_check',
      sql`to_state IN (${states})`,
    )
    .execute();

  await database.schema
    .createTable('work_item_records')
    .addColumn('id', 'bigserial', (column) => column.primaryKey())
    .addColumn('work_item_id', 'uuid', (column) =>
      column.references('work_items.id').onDelete('cascade').notNull(),
    )
    .addColumn('kind', 'text', (column) => column.notNull())
    .addColumn('payload', 'jsonb', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();

  await database.schema
    .createTable('lifecycle_events')
    .addColumn('id', 'bigserial', (column) => column.primaryKey())
    .addColumn('work_item_id', 'uuid', (column) =>
      column.references('work_items.id').onDelete('cascade').notNull(),
    )
    .addColumn('kind', 'text', (column) => column.notNull())
    .addColumn('payload', 'jsonb', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();
}

export async function down(database: Kysely<Database>): Promise<void> {
  await database.schema.dropTable('lifecycle_events').execute();
  await database.schema.dropTable('work_item_records').execute();
  await database.schema.dropTable('work_item_history').execute();
  await database.schema.dropTable('work_items').execute();
  await database.schema.dropTable('runs').execute();
  await database.schema.dropTable('projects').execute();
}
