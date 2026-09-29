import type { Kysely } from 'kysely';

import type { Database } from '../database.js';

/** Who filed an item, and the item its filer held (spec §4.1, §4.10); null for the navigator. */
export async function up(database: Kysely<Database>): Promise<void> {
  await database.schema
    .alterTable('work_items')
    .addColumn('filed_by_run_id', 'uuid', (column) =>
      column.references('runs.id').onDelete('set null'),
    )
    .addColumn('discovered_from_id', 'uuid', (column) =>
      column.references('work_items.id').onDelete('set null'),
    )
    .execute();
}

export async function down(database: Kysely<Database>): Promise<void> {
  await database.schema
    .alterTable('work_items')
    .dropColumn('discovered_from_id')
    .dropColumn('filed_by_run_id')
    .execute();
}
