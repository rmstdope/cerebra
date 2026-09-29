import { sql, type Kysely } from 'kysely';

import type { Database } from '../database.js';

export async function up(database: Kysely<Database>): Promise<void> {
  await sql`ALTER TABLE runs DROP CONSTRAINT runs_status_check`.execute(
    database,
  );
  await sql`ALTER TABLE runs DROP CONSTRAINT runs_role_check`.execute(database);
  await sql`UPDATE runs SET status = 'finished' WHERE status = 'ended'`.execute(
    database,
  );
  await sql`
    ALTER TABLE runs
      ADD CONSTRAINT runs_status_check
        CHECK (status IN ('starting', 'active', 'awaiting_input', 'finished', 'failed')),
      ADD CONSTRAINT runs_role_check
        CHECK (role IN ('assistant', 'groomer', 'designer', 'builder', 'reviewer', 'verifier'))
  `.execute(database);

  await database.schema
    .alterTable('runs')
    .addColumn('project_id', 'uuid', (column) =>
      column.references('projects.id').onDelete('cascade'),
    )
    .addColumn('agent_name', 'text')
    .addColumn('token_hash', 'text', (column) => column.unique())
    .addColumn('container_id', 'text')
    .addColumn('session_id', 'text')
    .addColumn('cost_usd', 'double precision', (column) =>
      column.notNull().defaultTo(0),
    )
    .addColumn('ended_at', 'timestamptz')
    .addColumn('failure', 'text')
    .addColumn('start_failed', 'boolean', (column) =>
      column.notNull().defaultTo(false),
    )
    .execute();

  await sql`
    CREATE UNIQUE INDEX runs_one_live_run_per_agent ON runs (agent_id)
    WHERE status IN ('starting', 'active', 'awaiting_input')
  `.execute(database);

  await database.schema
    .createTable('run_events')
    .addColumn('id', 'bigserial', (column) => column.primaryKey())
    .addColumn('run_id', 'uuid', (column) =>
      column.references('runs.id').onDelete('cascade').notNull(),
    )
    .addColumn('position', 'integer', (column) => column.notNull())
    .addColumn('event', 'jsonb', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addUniqueConstraint('run_events_run_id_position_unique', [
      'run_id',
      'position',
    ])
    .execute();
}

export async function down(database: Kysely<Database>): Promise<void> {
  await database.schema.dropTable('run_events').execute();
  await sql`DROP INDEX runs_one_live_run_per_agent`.execute(database);
  await sql`ALTER TABLE runs DROP CONSTRAINT runs_status_check`.execute(
    database,
  );
  await sql`ALTER TABLE runs DROP CONSTRAINT runs_role_check`.execute(database);
  await sql`DELETE FROM runs WHERE role = 'assistant'`.execute(database);
  await sql`
    UPDATE runs
    SET status = CASE WHEN status IN ('finished', 'failed') THEN 'ended' ELSE 'active' END
  `.execute(database);
  await database.schema
    .alterTable('runs')
    .dropColumn('project_id')
    .dropColumn('agent_name')
    .dropColumn('token_hash')
    .dropColumn('container_id')
    .dropColumn('session_id')
    .dropColumn('cost_usd')
    .dropColumn('ended_at')
    .dropColumn('failure')
    .dropColumn('start_failed')
    .execute();
  await sql`
    ALTER TABLE runs
      ADD CONSTRAINT runs_status_check CHECK (status IN ('active', 'ended')),
      ADD CONSTRAINT runs_role_check
        CHECK (role IN ('groomer', 'designer', 'builder', 'reviewer', 'verifier'))
  `.execute(database);
}
