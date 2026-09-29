import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MigrationResult } from 'kysely/migration';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import type { Database } from '../database.js';

const migrationFolder = path.dirname(fileURLToPath(import.meta.url));

function migrator(
  database: import('kysely').Kysely<Database>,
  schema: string | undefined,
): Migrator {
  return new Migrator({
    db: database,
    migrationTableSchema: schema,
    provider: new FileMigrationProvider({
      fs,
      migrationFolder,
      path,
    }),
  });
}

export async function migrateToLatest(
  database: import('kysely').Kysely<Database>,
  schema?: string,
): Promise<readonly MigrationResult[]> {
  const { error, results } = await migrator(database, schema).migrateToLatest();

  if (error) {
    throw error;
  }

  return results ?? [];
}

/** Migrates to a named migration; tests use it to check what a later migration does to old rows. */
export async function migrateTo(
  database: import('kysely').Kysely<Database>,
  name: string,
  schema?: string,
): Promise<readonly MigrationResult[]> {
  const { error, results } = await migrator(database, schema).migrateTo(name);

  if (error) {
    throw error;
  }

  return results ?? [];
}
