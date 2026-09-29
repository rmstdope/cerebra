import {
  type ColumnMetadata,
  type DatabaseIntrospector,
  type DatabaseMetadataOptions,
  type Kysely,
  PostgresDialect,
  PostgresIntrospector,
  type SchemaMetadata,
  sql,
  type TableMetadata,
} from 'kysely';
import {
  DEFAULT_MIGRATION_LOCK_TABLE,
  DEFAULT_MIGRATION_TABLE,
} from 'kysely/migration';

interface ColumnRow {
  auto_incrementing: string | null;
  column: string;
  column_description: string | null;
  has_default: boolean;
  not_null: boolean;
  schema: string;
  table: string;
  table_type: string;
  type: string;
  type_schema: string;
}

/**
 * Kysely's Postgres introspector reads every schema in the database and calls
 * functions on each by name, so a schema dropped concurrently makes it throw.
 * This one reads only the connection's current schema.
 */
export class SchemaScopedIntrospector implements DatabaseIntrospector {
  readonly #database: Kysely<unknown>;

  constructor(database: Kysely<unknown>) {
    this.#database = database;
  }

  getSchemas(): Promise<SchemaMetadata[]> {
    return new PostgresIntrospector(this.#database).getSchemas();
  }

  async getTables(
    options: DatabaseMetadataOptions = { withInternalKyselyTables: false },
  ): Promise<TableMetadata[]> {
    const internalTables = options.withInternalKyselyTables
      ? sql``
      : sql`AND c.relname NOT IN (${DEFAULT_MIGRATION_TABLE}, ${DEFAULT_MIGRATION_LOCK_TABLE})`;
    const { rows } = await sql<ColumnRow>`
      SELECT
        a.attname AS column,
        a.attnotnull AS not_null,
        a.atthasdef AS has_default,
        c.relname AS table,
        c.relkind AS table_type,
        ns.nspname AS schema,
        typ.typname AS type,
        dtns.nspname AS type_schema,
        col_description(a.attrelid, a.attnum) AS column_description,
        pg_get_serial_sequence(
          quote_ident(ns.nspname) || '.' || quote_ident(c.relname),
          a.attname
        ) AS auto_incrementing
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON a.attrelid = c.oid
      JOIN pg_catalog.pg_namespace ns ON c.relnamespace = ns.oid
      JOIN pg_catalog.pg_type typ ON a.atttypid = typ.oid
      JOIN pg_catalog.pg_namespace dtns ON typ.typnamespace = dtns.oid
      WHERE ns.nspname = current_schema()
        AND c.relkind IN ('r', 'v', 'p', 'f')
        AND a.attnum >= 0
        AND NOT a.attisdropped
        ${internalTables}
      ORDER BY c.relname, a.attnum
    `.execute(this.#database);

    return tablesFromColumns(rows);
  }
}

function tablesFromColumns(rows: readonly ColumnRow[]): TableMetadata[] {
  const tables = new Map<
    string,
    TableMetadata & { columns: ColumnMetadata[] }
  >();

  for (const row of rows) {
    let table = tables.get(row.table);

    if (!table) {
      table = {
        columns: [],
        isForeign: row.table_type === 'f',
        isView: row.table_type === 'v',
        name: row.table,
        schema: row.schema,
      };
      tables.set(row.table, table);
    }

    table.columns.push({
      comment: row.column_description ?? undefined,
      dataType: row.type,
      dataTypeSchema: row.type_schema,
      hasDefaultValue: row.has_default,
      isAutoIncrementing: row.auto_incrementing !== null,
      isNullable: !row.not_null,
      name: row.column,
    });
  }

  return [...tables.values()];
}

export class SchemaScopedPostgresDialect extends PostgresDialect {
  override createIntrospector(database: Kysely<unknown>): DatabaseIntrospector {
    return new SchemaScopedIntrospector(database);
  }
}
