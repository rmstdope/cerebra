import { sql, type Kysely } from 'kysely';

import type { Database } from '../database.js';

export async function up(database: Kysely<Database>): Promise<void> {
  await database.schema
    .createTable('agent_types')
    .addColumn('id', 'uuid', (column) => column.primaryKey())
    .addColumn('name', 'text', (column) => column.notNull().unique())
    .addColumn('role', 'text', (column) => column.notNull())
    .addColumn('model', 'text', (column) => column.notNull())
    .addColumn('interactive', 'boolean', (column) => column.notNull())
    .addColumn('triggers', 'jsonb', (column) => column.notNull())
    .addColumn('default_count', 'integer', (column) => column.notNull())
    .addColumn('default_names', 'jsonb', (column) => column.notNull())
    .addColumn('instructions', 'text', (column) => column.notNull())
    .addColumn('definition', 'jsonb', (column) => column.notNull())
    .addColumn('position', 'integer', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint(
      'agent_types_role_check',
      sql`role IN ('assistant', 'groomer', 'designer', 'producer', 'bugfixer', 'reviewer')`,
    )
    .addCheckConstraint(
      'agent_types_default_count_check',
      sql`default_count >= 0`,
    )
    .execute();

  await database.schema
    .createTable('agent_type_overrides')
    .addColumn('project_id', 'uuid', (column) =>
      column.references('projects.id').onDelete('cascade').notNull(),
    )
    .addColumn('agent_type_id', 'uuid', (column) =>
      column.references('agent_types.id').onDelete('cascade').notNull(),
    )
    .addColumn('fields', 'jsonb', (column) => column.notNull())
    .addPrimaryKeyConstraint('agent_type_overrides_pkey', [
      'project_id',
      'agent_type_id',
    ])
    .execute();

  await database.schema
    .createTable('agents')
    .addColumn('id', 'uuid', (column) => column.primaryKey())
    .addColumn('project_id', 'uuid', (column) =>
      column.references('projects.id').onDelete('cascade').notNull(),
    )
    .addColumn('agent_type_id', 'uuid', (column) =>
      column.references('agent_types.id').onDelete('restrict').notNull(),
    )
    .addColumn('name', 'text', (column) => column.notNull())
    .addColumn('enabled', 'boolean', (column) =>
      column.notNull().defaultTo(true),
    )
    .addColumn('created_sequence', 'bigserial', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint('agents_name_check', sql`btrim(name) <> ''`)
    .execute();

  await sql`CREATE UNIQUE INDEX agents_project_name_unique ON agents (project_id, lower(name))`.execute(
    database,
  );

  await database.schema
    .alterTable('projects')
    .addColumn('fleet_created', 'boolean', (column) =>
      column.notNull().defaultTo(false),
    )
    .execute();

  await database.schema
    .alterTable('runs')
    .addColumn('agent_id', 'uuid', (column) =>
      column.references('agents.id').onDelete('set null'),
    )
    .execute();
}

export async function down(database: Kysely<Database>): Promise<void> {
  await database.schema.alterTable('runs').dropColumn('agent_id').execute();
  await database.schema
    .alterTable('projects')
    .dropColumn('fleet_created')
    .execute();
  await database.schema.dropTable('agents').execute();
  await database.schema.dropTable('agent_type_overrides').execute();
  await database.schema.dropTable('agent_types').execute();
}
