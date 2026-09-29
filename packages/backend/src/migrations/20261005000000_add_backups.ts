import { sql, type Kysely } from 'kysely';

import type { Database } from '../database.js';

/**
 * Every attempt at a scheduled or manual database dump (architecture §10, *Backups*). Only a
 * `completed` row names a file that is a usable backup.
 */
export async function up(database: Kysely<Database>): Promise<void> {
  await database.schema
    .createTable('backups')
    .addColumn('id', 'bigserial', (column) => column.primaryKey())
    .addColumn('trigger', 'text', (column) =>
      column.notNull().check(sql`trigger in ('scheduled', 'manual')`),
    )
    .addColumn('status', 'text', (column) =>
      column.notNull().check(sql`status in ('running', 'completed', 'failed')`),
    )
    .addColumn('started_at', 'timestamptz', (column) => column.notNull())
    .addColumn('finished_at', 'timestamptz')
    .addColumn('file_name', 'text')
    .addColumn('size_bytes', 'bigint')
    .addColumn('cause', 'text')
    .addCheckConstraint(
      'backups_finished_unless_running',
      sql`(status = 'running') = (finished_at is null)`,
    )
    .addCheckConstraint(
      'backups_completed_has_file',
      sql`status <> 'completed' or (file_name is not null and size_bytes is not null)`,
    )
    .addCheckConstraint(
      'backups_failed_has_cause',
      sql`status <> 'failed' or cause is not null`,
    )
    .execute();
  // One backup at a time, whoever started it.
  await sql`create unique index backups_one_running on ${sql.table('backups')} ((true)) where status = 'running'`.execute(
    database,
  );

  await database.schema
    .createTable('backup_schedule')
    .addColumn('id', 'boolean', (column) =>
      column
        .primaryKey()
        .defaultTo(true)
        .check(sql`id`),
    )
    .addColumn('scheduled_since', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();
  await database.insertInto('backup_schedule').defaultValues().execute();
}

export async function down(database: Kysely<Database>): Promise<void> {
  await database.schema.dropTable('backup_schedule').execute();
  await database.schema.dropTable('backups').execute();
}
