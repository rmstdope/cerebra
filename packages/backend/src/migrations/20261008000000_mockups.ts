import { sql, type Kysely } from 'kysely';

import type { Database } from '../database.js';

/** A designer's drawings, kept with the item they were drawn for (spec §6.4, architecture §11). */
export async function up(database: Kysely<Database>): Promise<void> {
  await database.schema
    .createTable('mockups')
    .addColumn('id', 'uuid', (column) => column.primaryKey())
    .addColumn('work_item_id', 'uuid', (column) =>
      column.references('work_items.id').onDelete('cascade').notNull(),
    )
    .addColumn('run_id', 'uuid', (column) =>
      column.references('runs.id').onDelete('cascade').notNull(),
    )
    .addColumn('path', 'text', (column) => column.notNull())
    .addColumn('content_type', 'text', (column) => column.notNull())
    .addColumn('content', 'bytea', (column) => column.notNull())
    .addColumn('created_at', 'timestamptz', (column) =>
      column.notNull().defaultTo(sql`now()`),
    )
    .addCheckConstraint(
      'mockups_content_type_check',
      sql`content_type IN ('text/html', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml')`,
    )
    .execute();
}

export async function down(database: Kysely<Database>): Promise<void> {
  await database.schema.dropTable('mockups').execute();
}
