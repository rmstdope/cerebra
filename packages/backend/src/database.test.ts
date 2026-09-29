import { sql } from 'kysely';
import { Pool } from 'pg';
import { describe, expect, test } from 'vitest';

import { createDatabase } from './database.js';
import { migrateToLatest } from './migrations/index.js';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to run database tests');
}

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

  return schema;
}

async function dropSchema(schema: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await pool.end();
  }
}

describe('database migrations', { concurrent: false }, () => {
  test('rejects an unreachable database connection', async () => {
    const unreachableUrl = new URL(databaseUrl);
    unreachableUrl.hostname = '127.0.0.1';
    unreachableUrl.port = '1';
    const database = createDatabase(unreachableUrl.toString());

    try {
      await expect(migrateToLatest(database)).rejects.toThrow();
    } finally {
      await database.destroy();
    }
  });

  test('migrates a fresh schema', async () => {
    const schema = await createSchema();
    const database = createDatabase(databaseUrl, schema);

    try {
      const results = await migrateToLatest(database, schema);

      expect(results).toEqual([
        expect.objectContaining({
          migrationName: '20260928190000_create_users',
          status: 'Success',
        }),
        expect.objectContaining({
          migrationName: '20260928210000_create_lifecycle',
          status: 'Success',
        }),
        expect.objectContaining({
          migrationName: '20260928220000_add_project_registration',
          status: 'Success',
        }),
        expect.objectContaining({
          migrationName: '20260928220000_create_sessions',
          status: 'Success',
        }),
        expect.objectContaining({
          migrationName: '20260928230000_create_authentication_configuration',
          status: 'Success',
        }),
        expect.objectContaining({
          migrationName: '20260929010000_add_board_content',
          status: 'Success',
        }),
        expect.objectContaining({
          migrationName: '20260929030000_create_credentials',
          status: 'Success',
        }),
        expect.objectContaining({
          migrationName: '20260929040000_create_fleet',
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
          expect.objectContaining({ name: 'agent_credentials' }),
          expect.objectContaining({ name: 'authentication_configuration' }),
          expect.objectContaining({ name: 'agent_types' }),
          expect.objectContaining({ name: 'agent_type_overrides' }),
          expect.objectContaining({ name: 'agents' }),
          expect.objectContaining({ name: 'credentials' }),
          expect.objectContaining({ name: 'lifecycle_events' }),
          expect.objectContaining({ name: 'projects' }),
          expect.objectContaining({ name: 'runs' }),
          expect.objectContaining({ name: 'sessions' }),
          expect.objectContaining({ name: 'work_item_comments' }),
          expect.objectContaining({ name: 'users' }),
          expect.objectContaining({ name: 'work_item_history' }),
          expect.objectContaining({ name: 'work_item_records' }),
          expect.objectContaining({ name: 'work_items' }),
        ]),
      );
    } finally {
      await database.destroy();
      await dropSchema(schema);
    }
  });

  test('does not change an already-migrated schema', async () => {
    const schema = await createSchema();
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
      await dropSchema(schema);
    }
  });

  test('rejects a failed migration', async () => {
    const schema = await createSchema();
    const database = createDatabase(databaseUrl, schema);

    try {
      await database.schema.createTable('users').execute();

      await expect(migrateToLatest(database, schema)).rejects.toThrow();
    } finally {
      await database.destroy();
      await dropSchema(schema);
    }
  });

  test('refuses direct work-item writes that violate single-row invariants', async () => {
    const schema = await createSchema();
    const database = createDatabase(databaseUrl, schema);
    const projectId = crypto.randomUUID();

    try {
      await migrateToLatest(database, schema);
      await sql`
        INSERT INTO projects (id, name)
        VALUES (${projectId}, 'Lifecycle test project')
      `.execute(database);

      await expect(
        sql`
          INSERT INTO work_items (id, project_id, state, priority)
          VALUES (${crypto.randomUUID()}, ${projectId}, 'building', 'P1')
        `.execute(database),
      ).rejects.toThrow();

      await expect(
        sql`
          INSERT INTO work_items (id, project_id, state, priority, waiting_kind)
          VALUES (
            ${crypto.randomUUID()},
            ${projectId},
            'waiting',
            'P1',
            'question'
          )
        `.execute(database),
      ).rejects.toThrow();

      await expect(
        sql`
          INSERT INTO work_items (id, project_id, state, priority)
          VALUES (${crypto.randomUUID()}, ${projectId}, 'new', 'P1')
        `.execute(database),
      ).rejects.toThrow();

      await expect(
        sql`
          INSERT INTO work_items (id, project_id, state, priority)
          VALUES (${crypto.randomUUID()}, ${projectId}, 'not_a_state', 'P1')
        `.execute(database),
      ).rejects.toThrow();
    } finally {
      await database.destroy();
      await dropSchema(schema);
    }
  });
});
