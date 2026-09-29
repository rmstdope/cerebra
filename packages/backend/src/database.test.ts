import { sql } from 'kysely';
import { Pool } from 'pg';
import { describe, expect, test } from 'vitest';

import { createDatabase } from './database.js';
import { migrateTo, migrateToLatest } from './migrations/index.js';

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
        expect.objectContaining({
          migrationName: '20261001000000_supervise_runs',
          status: 'Success',
        }),
        expect.objectContaining({
          migrationName: '20261002000000_add_filing_provenance',
          status: 'Success',
        }),
        expect.objectContaining({
          migrationName: '20261003000000_add_dispatcher',
          status: 'Success',
        }),
        expect.objectContaining({
          migrationName: '20261004000000_add_builder_delivery',
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
          expect.objectContaining({ name: 'dispatch_log' }),
          expect.objectContaining({ name: 'instance_settings' }),
          expect.objectContaining({ name: 'lifecycle_events' }),
          expect.objectContaining({ name: 'projects' }),
          expect.objectContaining({ name: 'runs' }),
          expect.objectContaining({ name: 'run_events' }),
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

  test("introspects only the database's own schema", async () => {
    const schema = await createSchema();
    const otherSchema = await createSchema();
    const database = createDatabase(databaseUrl, schema);
    const pool = new Pool({ connectionString: databaseUrl });

    try {
      await pool.query(`CREATE TABLE "${schema}".own_table (id serial)`);
      await pool.query(`CREATE TABLE "${otherSchema}".other_table (id serial)`);

      const tables = await database.introspection.getTables({
        withInternalKyselyTables: true,
      });

      expect(tables).toEqual([
        expect.objectContaining({
          columns: [
            expect.objectContaining({
              dataType: 'int4',
              isAutoIncrementing: true,
              name: 'id',
            }),
          ],
          name: 'own_table',
          schema,
        }),
      ]);
    } finally {
      await pool.end();
      await database.destroy();
      await dropSchema(otherSchema);
      await dropSchema(schema);
    }
  });

  test('reads its tables while other schemas are created and dropped', async () => {
    const schema = await createSchema();
    const database = createDatabase(databaseUrl, schema);
    const pool = new Pool({ connectionString: databaseUrl });
    let churning = true;

    async function churn(): Promise<void> {
      while (churning) {
        const other = schemaName();
        await pool.query(`CREATE SCHEMA "${other}"`);
        await pool.query(`CREATE TABLE "${other}".churn (id serial)`);
        await pool.query(`DROP SCHEMA "${other}" CASCADE`);
      }
    }

    try {
      await migrateToLatest(database, schema);
      const churners = [churn(), churn()];

      try {
        for (let read = 0; read < 50; read += 1) {
          await database.introspection.getTables({
            withInternalKyselyTables: true,
          });
        }
      } finally {
        churning = false;
        await Promise.all(churners);
      }
    } finally {
      await pool.end();
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

  test('keeps every project limit within the Cerebra-wide limit it adds', async () => {
    const schema = await createSchema();
    const database = createDatabase(databaseUrl, schema);
    const busy = crypto.randomUUID();
    const quiet = crypto.randomUUID();

    try {
      await migrateTo(database, '20261002000000_add_filing_provenance', schema);
      await sql`
        INSERT INTO projects (id, name, max_concurrent_runs)
        VALUES (${busy}, 'Busy', 10), (${quiet}, 'Quiet', 2)
      `.execute(database);

      await migrateToLatest(database, schema);

      expect(
        await database
          .selectFrom('instance_settings')
          .select('max_concurrent_runs')
          .execute(),
      ).toEqual([{ max_concurrent_runs: 3 }]);
      expect(
        await database
          .selectFrom('projects')
          .select(['name', 'max_concurrent_runs', 'automatic_starts_paused'])
          .orderBy('name')
          .execute(),
      ).toEqual([
        {
          automatic_starts_paused: false,
          max_concurrent_runs: 3,
          name: 'Busy',
        },
        {
          automatic_starts_paused: false,
          max_concurrent_runs: 2,
          name: 'Quiet',
        },
      ]);
      await expect(
        sql`UPDATE projects SET max_concurrent_runs = 0`.execute(database),
      ).rejects.toThrow();
      await expect(
        sql`INSERT INTO instance_settings (id) VALUES (false)`.execute(
          database,
        ),
      ).rejects.toThrow();
    } finally {
      await database.destroy();
      await dropSchema(schema);
    }
  });

  test('turns an ended run into a finished one and checks run states', async () => {
    const schema = await createSchema();
    const database = createDatabase(databaseUrl, schema);
    const ended = crypto.randomUUID();

    try {
      await migrateTo(database, '20260929040000_create_fleet', schema);
      await sql`
        INSERT INTO runs (id, role, status) VALUES (${ended}, 'builder', 'ended')
      `.execute(database);

      await migrateToLatest(database, schema);

      const run = await database
        .selectFrom('runs')
        .select(['status', 'start_failed', 'cost_usd'])
        .where('id', '=', ended)
        .executeTakeFirstOrThrow();
      expect(run).toEqual({
        cost_usd: 0,
        start_failed: false,
        status: 'finished',
      });
      await expect(
        sql`
          INSERT INTO runs (id, role, status)
          VALUES (${crypto.randomUUID()}, 'assistant', 'parked')
        `.execute(database),
      ).rejects.toThrow();
      await expect(
        sql`
          INSERT INTO runs (id, role, status)
          VALUES (${crypto.randomUUID()}, 'painter', 'starting')
        `.execute(database),
      ).rejects.toThrow();
      const assistant = crypto.randomUUID();
      await sql`
        INSERT INTO runs (id, role, status)
        VALUES (${assistant}, 'assistant', 'starting')
      `.execute(database);
      await sql`
        INSERT INTO run_events (run_id, position, event)
        VALUES (${assistant}, 1, '{"kind":"message","text":"Hello"}')
      `.execute(database);
      await expect(
        sql`
          INSERT INTO run_events (run_id, position, event)
          VALUES (${assistant}, 1, '{"kind":"message","text":"Again"}')
        `.execute(database),
      ).rejects.toThrow();
    } finally {
      await database.destroy();
      await dropSchema(schema);
    }
  });
  test('gives every item a key and type, and keeps the run a record came from', async () => {
    const schema = await createSchema();
    const database = createDatabase(databaseUrl, schema);
    const web = crypto.randomUUID();
    const bare = crypto.randomUUID();
    const [first, second, third] = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];

    try {
      await migrateTo(database, '20261003000000_add_dispatcher', schema);
      await sql`
        INSERT INTO projects (id, name, key_prefix)
        VALUES (${web}, 'Web', 'web'), (${bare}, 'Bare', NULL)
      `.execute(database);
      await sql`
        INSERT INTO work_items (id, project_id, state) VALUES (${second}, ${web}, 'new')
      `.execute(database);
      await sql`
        INSERT INTO work_items (id, project_id, state) VALUES (${first}, ${bare}, 'new')
      `.execute(database);
      await sql`
        INSERT INTO work_items (id, project_id, state) VALUES (${third}, ${web}, 'new')
      `.execute(database);

      await migrateToLatest(database, schema);

      const keys = await database
        .selectFrom('work_items')
        .select(['id', 'key', 'type'])
        .execute();
      expect(new Map(keys.map((row) => [row.id, [row.key, row.type]]))).toEqual(
        new Map([
          [second, ['web-1', 'feature']],
          [third, ['web-2', 'feature']],
          [first, ['item-1', 'feature']],
        ]),
      );

      const next = crypto.randomUUID();
      await sql`
        INSERT INTO work_items (id, project_id, state, type)
        VALUES (${next}, ${web}, 'new', 'bug')
      `.execute(database);
      expect(
        await database
          .selectFrom('work_items')
          .select(['key', 'type'])
          .where('id', '=', next)
          .executeTakeFirstOrThrow(),
      ).toEqual({ key: 'web-3', type: 'bug' });
      await expect(
        sql`
          INSERT INTO work_items (id, project_id, state, type)
          VALUES (${crypto.randomUUID()}, ${web}, 'new', 'chore')
        `.execute(database),
      ).rejects.toThrow();
      await expect(
        sql`UPDATE work_items SET key = 'web-1' WHERE id = ${third}`.execute(
          database,
        ),
      ).rejects.toThrow();

      const run = crypto.randomUUID();
      await sql`
        INSERT INTO runs (id, role, status) VALUES (${run}, 'builder', 'active')
      `.execute(database);
      await sql`
        INSERT INTO work_item_records (work_item_id, kind, payload, run_id)
        VALUES (${next}, 'plan', '{}', ${run})
      `.execute(database);
      expect(
        await database
          .selectFrom('work_item_records')
          .select('run_id')
          .executeTakeFirstOrThrow(),
      ).toEqual({ run_id: run });
    } finally {
      await database.destroy();
      await dropSchema(schema);
    }
  });
});
