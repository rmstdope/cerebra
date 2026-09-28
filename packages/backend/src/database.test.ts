import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createDatabase } from './database.js';
import { migrateToLatest } from './migrations/index.js';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to run database tests');
}

const schemas: string[] = [];

function schemaName(): string {
  return `cerebra_test_${crypto.randomUUID().replaceAll('-', '')}`;
}

async function createSchema(): Promise<string> {
  const schema = schemaName();
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await pool.end();
  }

  schemas.push(schema);
  return schema;
}

beforeEach(async () => {
  await createSchema();
});

afterEach(async () => {
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    await Promise.all(
      schemas
        .splice(0)
        .map((schema) => pool.query(`DROP SCHEMA "${schema}" CASCADE`)),
    );
  } finally {
    await pool.end();
  }
});

describe('database migrations', () => {
  test('migrates a fresh schema', async () => {
    const schema = schemas[0];
    const database = createDatabase(databaseUrl, schema);

    try {
      const results = await migrateToLatest(database, schema);

      expect(results).toEqual([
        expect.objectContaining({
          migrationName: '20260928190000_create_users',
          status: 'Success',
        }),
      ]);
      expect(
        await database.introspection.getTables({
          withInternalKyselyTables: true,
        }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'kysely_migration' }),
          expect.objectContaining({ name: 'users' }),
        ]),
      );
    } finally {
      await database.destroy();
    }
  });

  test('does not change an already-migrated schema', async () => {
    const schema = schemas[0];
    const database = createDatabase(databaseUrl, schema);

    try {
      await migrateToLatest(database, schema);

      expect(await migrateToLatest(database, schema)).toEqual([]);
      expect(
        await database.introspection.getTables({
          withInternalKyselyTables: true,
        }),
      ).toContainEqual(expect.objectContaining({ name: 'users' }));
    } finally {
      await database.destroy();
    }
  });
});
