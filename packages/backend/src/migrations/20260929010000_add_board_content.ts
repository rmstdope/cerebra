import { sql, type Kysely } from 'kysely';

import type { Database } from '../database.js';

export async function up(database: Kysely<Database>): Promise<void> {
  await database.schema
    .alterTable('work_items')
    .addColumn('title', 'text', (column) => column.notNull().defaultTo(''))
    .addColumn('description', 'text', (column) =>
      column.notNull().defaultTo(''),
    )
    .addColumn('filed_sequence', 'bigserial', (column) => column.notNull())
    .execute();

  await database.schema
    .createIndex('work_items_project_filed_sequence')
    .on('work_items')
    .columns(['project_id', 'filed_sequence'])
    .execute();

  await database.schema
    .createTable('work_item_comments')
    .addColumn('id', 'bigserial', (column) => column.primaryKey())
    .addColumn('work_item_id', 'uuid', (column) =>
      column.references('work_items.id').onDelete('cascade').notNull(),
    )
    .addColumn('body', 'text', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .execute();
}

export async function down(database: Kysely<Database>): Promise<void> {
  await database.schema.dropTable('work_item_comments').execute();
  await database.schema
    .alterTable('work_items')
    .dropColumn('filed_sequence')
    .dropColumn('description')
    .dropColumn('title')
    .execute();
}
