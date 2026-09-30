import { sql, type Kysely } from 'kysely';

import type { Database } from '../database.js';

/**
 * Work carried over by hand from a classic beads board (roadmap step 9): each item names the old
 * item it came from, at most once per project, and its history says so in one entry.
 */
export async function up(database: Kysely<Database>): Promise<void> {
  await database.schema
    .alterTable('work_item_history')
    .addColumn('kind', 'text', (column) =>
      column
        .notNull()
        .defaultTo('transition')
        .check(sql`kind IN ('transition', 'carried_over')`),
    )
    .execute();

  await database.schema
    .alterTable('work_items')
    .addColumn('carried_from', 'text')
    .execute();

  await database.schema
    .createIndex('work_items_carried_from_unique')
    .on('work_items')
    .columns(['project_id', 'carried_from'])
    .unique()
    .where(sql.ref('carried_from'), 'is not', null)
    .execute();
}

export async function down(database: Kysely<Database>): Promise<void> {
  await database.schema.dropIndex('work_items_carried_from_unique').execute();
  await database.schema
    .alterTable('work_items')
    .dropColumn('carried_from')
    .execute();
  await database.schema
    .alterTable('work_item_history')
    .dropColumn('kind')
    .execute();
}
