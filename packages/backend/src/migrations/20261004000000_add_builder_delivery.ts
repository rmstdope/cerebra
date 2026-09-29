import { sql, type Kysely } from 'kysely';

import type { Database } from '../database.js';

/**
 * What builder delivery needs (spec §4.1, §4.11, §5.3): every item's key and type, and the run a
 * record came from. A key is the project's prefix and the project's next number, never reused.
 */
export async function up(database: Kysely<Database>): Promise<void> {
  await database.schema
    .alterTable('projects')
    .addColumn('item_sequence', 'bigint', (column) =>
      column.notNull().defaultTo(0),
    )
    .execute();
  await database.schema
    .alterTable('work_items')
    .addColumn('type', 'text', (column) =>
      column
        .notNull()
        .defaultTo('feature')
        .check(sql`type in ('feature', 'bug', 'task', 'refactoring')`),
    )
    .addColumn('key', 'text')
    .execute();

  await sql`
    create function assign_work_item_key() returns trigger language plpgsql as $$
    declare
      prefix text;
      number bigint;
    begin
      update projects set item_sequence = item_sequence + 1
        where id = new.project_id
        returning coalesce(nullif(key_prefix, ''), 'item'), item_sequence
        into prefix, number;
      new.key := prefix || '-' || number;
      return new;
    end;
    $$
  `.execute(database);

  // Existing items take their numbers in the order they were filed.
  await sql`
    with numbered as (
      select id, row_number() over (partition by project_id order by filed_sequence) as number
      from work_items
    )
    update work_items
    set key = coalesce(nullif(projects.key_prefix, ''), 'item') || '-' || numbered.number
    from numbered, projects
    where work_items.id = numbered.id and projects.id = work_items.project_id
  `.execute(database);
  await sql`
    update projects
    set item_sequence = (select count(*) from work_items where project_id = projects.id)
  `.execute(database);

  await sql`
    create trigger work_items_assign_key before insert on work_items
    for each row when (new.key is null) execute function assign_work_item_key()
  `.execute(database);
  await sql`alter table work_items alter column key set not null`.execute(
    database,
  );
  await database.schema
    .alterTable('work_items')
    .addUniqueConstraint('work_items_project_key_unique', ['project_id', 'key'])
    .execute();

  await database.schema
    .alterTable('work_item_records')
    .addColumn('run_id', 'uuid', (column) =>
      column.references('runs.id').onDelete('set null'),
    )
    .execute();
}

export async function down(database: Kysely<Database>): Promise<void> {
  await database.schema
    .alterTable('work_item_records')
    .dropColumn('run_id')
    .execute();
  await sql`drop trigger work_items_assign_key on work_items`.execute(database);
  await sql`drop function assign_work_item_key()`.execute(database);
  await database.schema
    .alterTable('work_items')
    .dropConstraint('work_items_project_key_unique')
    .execute();
  await database.schema
    .alterTable('work_items')
    .dropColumn('key')
    .dropColumn('type')
    .execute();
  await database.schema
    .alterTable('projects')
    .dropColumn('item_sequence')
    .execute();
}
