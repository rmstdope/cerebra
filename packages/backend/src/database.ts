import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

export interface Database {
  users: {
    created_at: Date;
    id: string;
    password_hash: string;
  };
}

function searchPathOption(schema: string | undefined): string | undefined {
  if (!schema) {
    return undefined;
  }

  if (!/^[a-z][a-z0-9_]*$/.test(schema)) {
    throw new Error(`Invalid PostgreSQL schema name: ${schema}`);
  }

  return `-c search_path=${schema},public`;
}

export function createDatabase(
  databaseUrl: string,
  schema?: string,
): Kysely<Database> {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: databaseUrl,
        options: searchPathOption(schema),
      }),
    }),
  });
}
