import { sql, type Kysely } from 'kysely';

import type { Database } from '../database.js';

export async function up(database: Kysely<Database>): Promise<void> {
  await database.schema
    .createTable('authentication_configuration')
    .addColumn('id', 'boolean', (column) =>
      column.primaryKey().notNull().defaultTo(true),
    )
    .addColumn('user_id', 'uuid', (column) =>
      column.notNull().unique().references('users.id').onDelete('cascade'),
    )
    .addCheckConstraint('single_navigator', sql`id`)
    .execute();
}

export async function down(database: Kysely<Database>): Promise<void> {
  await database.schema.dropTable('authentication_configuration').execute();
}
