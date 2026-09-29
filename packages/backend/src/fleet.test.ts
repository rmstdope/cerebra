import { Pool } from 'pg';
import { describe, expect, test } from 'vitest';

import {
  agentTypesDirectory,
  readAgentTypeDefinitions,
  type AgentTypeDefinition,
} from './agent-types.js';
import { ProjectNotFoundError } from './board.js';
import { createDatabase, type Database } from './database.js';
import {
  AgentHoldsWorkError,
  AgentNotFoundError,
  AgentTypeNotFoundError,
  createFleet,
  DuplicateAgentNameError,
  InvalidAgentNameError,
  InvalidRoleSettingsError,
  type Fleet,
} from './fleet.js';
import { migrateToLatest } from './migrations/index.js';
import { createProjectStore, listProjects } from './project-registration.js';
import type { Kysely } from 'kysely';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to run fleet tests');
}

const masterKey = Buffer.alloc(32, 7).toString('base64');

async function withFleet(
  run: (context: {
    readonly database: Kysely<Database>;
    readonly definitions: AgentTypeDefinition[];
    readonly fleet: Fleet;
  }) => Promise<void>,
): Promise<void> {
  const schema = `cerebra_fleet_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const pool = new Pool({ connectionString: databaseUrl });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  const database = createDatabase(databaseUrl ?? '', schema);
  try {
    await migrateToLatest(database, schema);
    const definitions = await readAgentTypeDefinitions(agentTypesDirectory);
    const fleet = createFleet(database);
    await fleet.seedAgentTypes(definitions);
    await run({ database, definitions, fleet });
  } finally {
    await database.destroy();
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
}

async function insertProject(
  database: Kysely<Database>,
  name = 'website',
): Promise<string> {
  const id = crypto.randomUUID();
  await database
    .insertInto('projects')
    .values({ id, name, owner: 'acme' })
    .execute();
  return id;
}

async function registerProject(database: Kysely<Database>): Promise<string> {
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

const defaultPeople = [
  ['Cerebro', 'assistant'],
  ['Jubilee', 'groomer'],
  ['Xavier', 'designer'],
  ['Cyclops', 'producer'],
  ['Storm', 'producer'],
  ['Bishop', 'bugfixer'],
  ['Emma', 'reviewer'],
];

describe('the fleet', { concurrent: false }, () => {
  test('lists registered projects from persistent storage without encrypted credentials', async () => {
    await withFleet(async ({ database }) => {
      expect(await listProjects(database)).toEqual([]);
      const id = await registerProject(database);
      expect(await listProjects(database)).toEqual([
        {
          id,
          name: 'website',
          owner: 'acme',
          prefix: 'WEB',
          defaultBranch: 'main',
          remote: 'https://github.com/acme/website.git',
        },
      ]);
    });
  });
  test('seeding twice keeps an edited type rather than overwriting it', async () => {
    await withFleet(async ({ database, definitions, fleet }) => {
      await database
        .updateTable('agent_types')
        .set({ model: 'haiku' })
        .where('name', '=', 'producer')
        .execute();

      await fleet.seedAgentTypes(definitions);

      const types = await database
        .selectFrom('agent_types')
        .select(['name', 'model'])
        .orderBy('position')
        .execute();
      expect(types.map((type) => type.name)).toEqual([
        'assistant',
        'groomer',
        'designer',
        'producer',
        'bugfixer',
        'reviewer',
      ]);
      expect(types.find((type) => type.name === 'producer')?.model).toBe(
        'haiku',
      );
    });
  });

  test('a registered project has the default fleet in stable order', async () => {
    await withFleet(async ({ database, fleet }) => {
      const projectId = await registerProject(database);

      const view = await fleet.read(projectId);

      expect(view.project).toEqual({
        id: projectId,
        name: 'website',
        owner: 'acme',
      });
      expect(view.people.map((person) => [person.name, person.role])).toEqual(
        defaultPeople,
      );
      expect(
        view.people.every(
          (person) => person.enabled && person.activity.kind === 'available',
        ),
      ).toBe(true);
      expect(await fleet.createMissingFleets()).toBe(0);
    });
  });

  test('a registration whose fleet cannot be created leaves no project', async () => {
    await withFleet(async ({ database }) => {
      await database.deleteFrom('agent_types').execute();

      await expect(registerProject(database)).rejects.toThrow();
      expect(
        await database.selectFrom('projects').select('id').execute(),
      ).toEqual([]);
    });
  });

  test('a project registered before fleets existed gets its fleet once', async () => {
    await withFleet(async ({ database, fleet }) => {
      const projectId = await insertProject(database);

      expect(await fleet.createMissingFleets()).toBe(1);
      const view = await fleet.read(projectId);
      expect(view.people.map((person) => person.name)).toEqual(
        defaultPeople.map(([name]) => name),
      );

      for (const person of view.people) {
        await fleet.removeAgent(person.id);
      }
      expect(await fleet.createMissingFleets()).toBe(0);
      expect((await fleet.read(projectId)).people).toEqual([]);
    });
  });

  test('reading an unknown project is refused, not an empty fleet', async () => {
    await withFleet(async ({ fleet }) => {
      await expect(fleet.read(crypto.randomUUID())).rejects.toBeInstanceOf(
        ProjectNotFoundError,
      );
    });
  });

  test('a person with a live run shows the work it holds', async () => {
    await withFleet(async ({ database, fleet }) => {
      const projectId = await registerProject(database);
      const storm = (await fleet.read(projectId)).people.find(
        (person) => person.name === 'Storm',
      );
      const runId = crypto.randomUUID();
      const itemId = crypto.randomUUID();
      await database
        .insertInto('runs')
        .values({ agent_id: storm?.id, id: runId, role: 'builder' })
        .execute();
      await database
        .insertInto('work_items')
        .values({
          attempts: 0,
          description: '',
          holder_run_id: runId,
          id: itemId,
          priority: 'P1',
          project_id: projectId,
          rounds: 0,
          state: 'building',
          title: 'Make reports easier to share',
        })
        .execute();

      const view = await fleet.read(projectId);

      expect(
        view.people.find((person) => person.name === 'Storm')?.activity,
      ).toEqual({
        item: { id: itemId, title: 'Make reports easier to share' },
        kind: 'working',
      });
      await expect(fleet.removeAgent(storm?.id ?? '')).rejects.toBeInstanceOf(
        AgentHoldsWorkError,
      );

      await database
        .updateTable('runs')
        .set({ status: 'finished' })
        .where('id', '=', runId)
        .execute();
      expect(
        (await fleet.read(projectId)).people.find(
          (person) => person.name === 'Storm',
        )?.activity,
      ).toEqual({ kind: 'available' });
    });
  });

  test('a person with a live run but no held item is running, not idle', async () => {
    await withFleet(async ({ database, fleet }) => {
      const projectId = await registerProject(database);
      const people = (await fleet.read(projectId)).people;
      const storm = people.find((person) => person.name === 'Storm');
      expect(storm?.running).toBe(false);
      await database
        .insertInto('runs')
        .values({
          agent_id: storm?.id,
          id: crypto.randomUUID(),
          role: 'builder',
        })
        .execute();

      const after = (await fleet.read(projectId)).people.find(
        (person) => person.name === 'Storm',
      );

      expect(after).toMatchObject({
        activity: { kind: 'available' },
        running: true,
      });
      await expect(fleet.removeAgent(storm?.id ?? '')).rejects.toBeInstanceOf(
        AgentHoldsWorkError,
      );
    });
  });

  test('a person shows their live conversation, and a start that failed until the next start', async () => {
    await withFleet(async ({ database, fleet }) => {
      const projectId = await registerProject(database);
      const cerebro = (await fleet.read(projectId)).people.find(
        (person) => person.name === 'Cerebro',
      );
      expect(cerebro).toMatchObject({ conversation: null, startFailed: false });
      const failedRun = crypto.randomUUID();
      await database
        .insertInto('runs')
        .values({
          agent_id: cerebro?.id,
          created_at: new Date(Date.now() - 60_000),
          id: failedRun,
          project_id: projectId,
          role: 'assistant',
          start_failed: true,
          status: 'failed',
        })
        .execute();
      const cerebroNow = async () =>
        (await fleet.read(projectId)).people.find(
          (person) => person.name === 'Cerebro',
        );
      expect(await cerebroNow()).toMatchObject({
        conversation: null,
        running: false,
        startFailed: true,
      });

      const liveRun = crypto.randomUUID();
      await database
        .insertInto('runs')
        .values({
          agent_id: cerebro?.id,
          id: liveRun,
          project_id: projectId,
          role: 'assistant',
          status: 'awaiting_input',
        })
        .execute();

      expect(await cerebroNow()).toMatchObject({
        conversation: { runId: liveRun, state: 'awaiting_input' },
        running: true,
        startFailed: false,
      });
    });
  });

  test('people are added, renamed, disabled and removed', async () => {
    await withFleet(async ({ database, fleet }) => {
      const projectId = await registerProject(database);
      const producer = (await fleet.read(projectId)).roles.find(
        (role) => role.role === 'producer',
      );

      const rogue = await fleet.addAgent(projectId, {
        name: '  Rogue ',
        typeId: producer?.typeId ?? '',
      });
      expect(rogue).toMatchObject({
        enabled: true,
        name: 'Rogue',
        role: 'producer',
      });
      expect(
        (await fleet.read(projectId)).people.map((person) => person.name),
      ).toEqual([
        'Cerebro',
        'Jubilee',
        'Xavier',
        'Cyclops',
        'Storm',
        'Rogue',
        'Bishop',
        'Emma',
      ]);

      await expect(
        fleet.addAgent(projectId, {
          name: 'storm',
          typeId: producer?.typeId ?? '',
        }),
      ).rejects.toBeInstanceOf(DuplicateAgentNameError);
      await expect(
        fleet.addAgent(projectId, {
          name: '  ',
          typeId: producer?.typeId ?? '',
        }),
      ).rejects.toBeInstanceOf(InvalidAgentNameError);
      await expect(
        fleet.addAgent(projectId, {
          name: 'Gambit',
          typeId: crypto.randomUUID(),
        }),
      ).rejects.toBeInstanceOf(AgentTypeNotFoundError);

      expect(
        await fleet.updateAgent(rogue.id, { enabled: false, name: 'Anna' }),
      ).toMatchObject({ enabled: false, name: 'Anna' });
      await expect(
        fleet.updateAgent(rogue.id, { name: 'CYCLOPS' }),
      ).rejects.toBeInstanceOf(DuplicateAgentNameError);

      await fleet.removeAgent(rogue.id);
      await expect(fleet.removeAgent(rogue.id)).rejects.toBeInstanceOf(
        AgentNotFoundError,
      );
      await expect(
        fleet.updateAgent(rogue.id, { enabled: true }),
      ).rejects.toBeInstanceOf(AgentNotFoundError);
    });
  });

  test('the same name may be used in two projects', async () => {
    await withFleet(async ({ database, fleet }) => {
      await registerProject(database);
      const other = await registerProject(database);

      expect(
        (await fleet.read(other)).people.map((person) => person.name),
      ).toContain('Storm');
    });
  });

  test('role settings are stored only where they differ from the default', async () => {
    await withFleet(async ({ database, fleet }) => {
      const projectId = await registerProject(database);
      const other = await registerProject(database);
      const producer = (await fleet.read(projectId)).roles.find(
        (role) => role.role === 'producer',
      );
      expect(producer).toMatchObject({
        model: 'opus',
        people: ['Cyclops', 'Storm'],
        startMode: 'ready',
      });

      const saved = await fleet.saveRoleSettings(
        projectId,
        producer?.typeId ?? '',
        { model: 'sonnet', startMode: 'manual' },
      );
      expect(saved).toMatchObject({ model: 'sonnet', startMode: 'manual' });
      expect(
        (await fleet.read(other)).roles.find(
          (role) => role.role === 'producer',
        ),
      ).toMatchObject({ model: 'opus', startMode: 'ready' });

      await fleet.saveRoleSettings(projectId, producer?.typeId ?? '', {
        model: 'sonnet',
        startMode: 'ready',
      });
      const override = await database
        .selectFrom('agent_type_overrides')
        .select('fields')
        .where('project_id', '=', projectId)
        .executeTakeFirstOrThrow();
      expect(override.fields).toEqual({ model: 'sonnet' });

      await database
        .updateTable('agent_types')
        .set({ model: 'haiku' })
        .where('name', '=', 'producer')
        .execute();
      await fleet.saveRoleSettings(projectId, producer?.typeId ?? '', {
        model: 'haiku',
        startMode: 'ready',
      });
      expect(
        await database
          .selectFrom('agent_type_overrides')
          .select('fields')
          .execute(),
      ).toEqual([]);
    });
  });

  test('role settings that do not apply are refused', async () => {
    await withFleet(async ({ database, fleet }) => {
      const projectId = await registerProject(database);
      const roles = (await fleet.read(projectId)).roles;
      const assistant = roles.find((role) => role.role === 'assistant');
      const producer = roles.find((role) => role.role === 'producer');
      expect(assistant).toMatchObject({ interactive: true, startMode: null });

      await expect(
        fleet.saveRoleSettings(projectId, assistant?.typeId ?? '', {
          model: 'opus',
          startMode: 'manual',
        }),
      ).rejects.toBeInstanceOf(InvalidRoleSettingsError);
      await expect(
        fleet.saveRoleSettings(projectId, producer?.typeId ?? '', {
          model: 'gpt',
          startMode: 'ready',
        }),
      ).rejects.toBeInstanceOf(InvalidRoleSettingsError);
      expect(
        await fleet.saveRoleSettings(projectId, assistant?.typeId ?? '', {
          model: 'sonnet',
          startMode: null,
        }),
      ).toMatchObject({ model: 'sonnet', startMode: null });
    });
  });
});
