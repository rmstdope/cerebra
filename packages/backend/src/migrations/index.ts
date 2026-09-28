import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MigrationResult } from 'kysely/migration';
import { FileMigrationProvider, Migrator } from 'kysely/migration';

import type { Database } from '../database.js';

const migrationFolder = path.dirname(fileURLToPath(import.meta.url));

export async function migrateToLatest(
  database: import('kysely').Kysely<Database>,
  schema?: string,
): Promise<readonly MigrationResult[]> {
  const migrator = new Migrator({
    db: database,
    migrationTableSchema: schema,
    provider: new FileMigrationProvider({
      fs,
      migrationFolder,
      path,
    }),
  });
  const { error, results } = await migrator.migrateToLatest();

  if (error) {
    throw error;
  }

  return results ?? [];
}
