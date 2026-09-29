import { sql, type Kysely } from 'kysely';

import type { Database } from '../database.js';

export async function up(database: Kysely<Database>): Promise<void> {
  await database.schema
    .createTable('credentials')
    .addColumn('id', 'uuid', (column) => column.primaryKey())
    .addColumn('name', 'text', (column) =>
      column.notNull().check(sql`char_length(name) between 1 and 100`),
    )
    .addColumn('project_id', 'uuid', (column) =>
      column.references('projects.id').onDelete('cascade'),
    )
    .addColumn('value_ciphertext', 'text', (column) => column.notNull())
    .addColumn('value_iv', 'text', (column) => column.notNull())
    .addColumn('value_tag', 'text', (column) => column.notNull())
    .addColumn('key_ciphertext', 'text', (column) => column.notNull())
    .addColumn('key_iv', 'text', (column) => column.notNull())
    .addColumn('key_tag', 'text', (column) => column.notNull())
    .addColumn('problem', 'text', (column) =>
      column.check(sql`problem in ('undecryptable', 'injection_failed')`),
    )
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn('updated_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addColumn('last_used_at', 'timestamptz')
    .addColumn('last_used_run_id', 'text')
    .execute();

  await database.schema
    .createIndex('credentials_instance_name')
    .on('credentials')
    .column('name')
    .unique()
    .where(sql.ref('project_id'), 'is', null)
    .execute();

  await database.schema
    .createIndex('credentials_project_name')
    .on('credentials')
    .columns(['project_id', 'name'])
    .unique()
    .where(sql.ref('project_id'), 'is not', null)
    .execute();

  await database.schema
    .createTable('agent_credentials')
    .addColumn('id', 'bigserial', (column) => column.primaryKey())
    .addColumn('project_id', 'uuid', (column) =>
      column.notNull().references('projects.id').onDelete('cascade'),
    )
    .addColumn('agent_type', 'text', (column) => column.notNull())
    .addColumn('credential_name', 'text', (column) => column.notNull())
    .addColumn('delivery', 'text', (column) =>
      column.notNull().check(sql`delivery in ('environment', 'file')`),
    )
    .addColumn('destination', 'text', (column) => column.notNull())
    .addUniqueConstraint('agent_credentials_destination', [
      'project_id',
      'agent_type',
      'destination',
    ])
    .execute();
}

export async function down(database: Kysely<Database>): Promise<void> {
  await database.schema.dropTable('agent_credentials').execute();
  await database.schema.dropTable('credentials').execute();
}
