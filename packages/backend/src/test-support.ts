import type { Kysely } from 'kysely';
import { Pool } from 'pg';

import { agentTypesDirectory, readAgentTypeDefinitions } from './agent-types.js';
import { createDatabase, type Database } from './database.js';
import { createFleet } from './fleet.js';
import { migrateToLatest } from './migrations/index.js';
import { createProjectStore } from './project-registration.js';

const masterKey = Buffer.alloc(32, 7).toString('base64');

/** A migrated, seeded schema of its own for one test, dropped afterwards. */
export async function withTestDatabase(
  run: (database: Kysely<Database>) => Promise<void>,
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run database tests');
  }
  const schema = `cerebra_runs_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: databaseUrl });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const database = createDatabase(databaseUrl, schema);
  try {
    await migrateToLatest(database, schema);
    await createFleet(database).seedAgentTypes(
      await readAgentTypeDefinitions(agentTypesDirectory),
    );
    await run(database);
  } finally {
    await database.destroy();
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
}

/** Registers a project with its default fleet and answers its id. */
export async function registerTestProject(
  database: Kysely<Database>,
): Promise<string> {
  const id = crypto.randomUUID();
  await createProjectStore({ database, masterKey }).create({
    credential: 'token',
    project: {
      defaultBranch: 'main',
      id,
      name: 'website',
      owner: 'acme',
      prefix: 'WEB',
      remote: 'https://github.com/acme/website.git',
    },
  });
  return id;
}

export async function agentNamed(
  database: Kysely<Database>,
  projectId: string,
  name: string,
): Promise<string> {
  const agent = await database
    .selectFrom('agents')
    .select('id')
    .where('project_id', '=', projectId)
    .where('name', '=', name)
    .executeTakeFirstOrThrow();
  return agent.id;
}
