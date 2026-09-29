import type { Kysely, Transaction } from 'kysely';

import {
  isAgentModel,
  type AgentModel,
  type AgentRole,
  type AgentTrigger,
  type AgentTypeDefinition,
} from './agent-types.js';
import { ProjectNotFoundError } from './board.js';
import type { AgentTypeOverrideFields, Database } from './database.js';

export type StartMode = 'ready' | 'manual';

export type AgentActivity =
  | { readonly kind: 'available' }
  | {
      readonly item: FleetItem;
      readonly kind: 'working';
    }
  | {
      readonly item: FleetItem;
      readonly kind: 'waiting';
      readonly question: string;
    };

export interface FleetItem {
  readonly id: string;
  readonly title: string;
}

export interface FleetPerson {
  readonly activity: AgentActivity;
  readonly enabled: boolean;
  readonly id: string;
  readonly name: string;
  readonly role: AgentRole;
  /** True while the person has a live run, whether or not it holds work. */
  readonly running: boolean;
  readonly typeId: string;
}

export interface FleetRole {
  readonly interactive: boolean;
  readonly model: AgentModel;
  readonly people: readonly string[];
  readonly role: AgentRole;
  /** How its people start; `null` for an interactive type, which only the navigator starts. */
  readonly startMode: StartMode | null;
  readonly typeId: string;
}

export interface FleetView {
  readonly people: readonly FleetPerson[];
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly owner: string;
  };
  readonly roles: readonly FleetRole[];
}

export interface RoleSettings {
  readonly model: unknown;
  readonly startMode: unknown;
}

export interface Fleet {
  addAgent(
    projectId: string,
    input: { readonly name: unknown; readonly typeId: string },
  ): Promise<FleetPerson>;
  /** Gives every project registered before fleets existed its default fleet, once. */
  createMissingFleets(): Promise<number>;
  read(projectId: string): Promise<FleetView>;
  removeAgent(agentId: string): Promise<void>;
  saveRoleSettings(
    projectId: string,
    typeId: string,
    settings: RoleSettings,
  ): Promise<FleetRole>;
  /** Inserts the shipped types that are not stored yet; a stored type is never overwritten. */
  seedAgentTypes(definitions: readonly AgentTypeDefinition[]): Promise<void>;
  updateAgent(
    agentId: string,
    changes: { readonly enabled?: unknown; readonly name?: unknown },
  ): Promise<FleetPerson>;
}

/** Starts and stops a person's run; supplied once run supervision exists (cr-edk.5). */
export interface RunControl {
  start(agentId: string): Promise<void>;
  stop(agentId: string): Promise<void>;
}

export class AgentNotFoundError extends Error {
  public constructor(agentId: string) {
    super(`Agent ${agentId} was not found`);
    this.name = 'AgentNotFoundError';
  }
}

export class AgentTypeNotFoundError extends Error {
  public constructor(typeId: string) {
    super(`Agent type ${typeId} was not found`);
    this.name = 'AgentTypeNotFoundError';
  }
}

export class DuplicateAgentNameError extends Error {
  public constructor(public readonly agentName: string) {
    super(`Another person in this fleet is already called ${agentName}.`);
    this.name = 'DuplicateAgentNameError';
  }
}

export class InvalidAgentNameError extends Error {
  public constructor() {
    super('Enter a name.');
    this.name = 'InvalidAgentNameError';
  }
}

export class InvalidAgentChangeError extends Error {
  public constructor() {
    super('Enabled must be true or false.');
    this.name = 'InvalidAgentChangeError';
  }
}

export class AgentHoldsWorkError extends Error {
  public constructor(public readonly agentName: string) {
    super(`Stop this work before removing ${agentName}.`);
    this.name = 'AgentHoldsWorkError';
  }
}

export class InvalidRoleSettingsError extends Error {
  public constructor(field: 'model' | 'startMode') {
    super(`The role settings have an invalid ${field}.`);
    this.name = 'InvalidRoleSettingsError';
  }
}

export class NoAgentTypesError extends Error {
  public constructor() {
    super('No agent types are configured, so no fleet can be created.');
    this.name = 'NoAgentTypesError';
  }
}

const readyTriggers: AgentTrigger[] = [
  { kind: 'state' },
  { kind: 'navigator' },
];
const manualTriggers: AgentTrigger[] = [{ kind: 'navigator' }];

function startModeOf(
  interactive: boolean,
  triggers: readonly AgentTrigger[],
): StartMode | null {
  if (interactive) {
    return null;
  }
  return triggers.some((trigger) => trigger.kind === 'state')
    ? 'ready'
    : 'manual';
}

function sameTriggers(
  left: readonly AgentTrigger[],
  right: readonly AgentTrigger[],
): boolean {
  const kinds = (triggers: readonly AgentTrigger[]) =>
    [...new Set(triggers.map((trigger) => trigger.kind))].sort().join();
  return kinds(left) === kinds(right);
}

function agentName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (name === '' || name.length > 60) {
    throw new InvalidAgentNameError();
  }
  return name;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  );
}

/**
 * Inserts a project's default fleet inside the caller's transaction and marks the project as
 * having one, so that the start-up backfill never recreates a fleet the navigator emptied.
 */
export async function createDefaultFleet(
  transaction: Transaction<Database>,
  projectId: string,
): Promise<void> {
  const types = await transaction
    .selectFrom('agent_types')
    .select(['id', 'default_count', 'default_names'])
    .orderBy('position')
    .execute();
  if (types.length === 0) {
    throw new NoAgentTypesError();
  }
  const agents = types.flatMap((type) =>
    type.default_names.slice(0, type.default_count).map((name) => ({
      agent_type_id: type.id,
      id: crypto.randomUUID(),
      name,
      project_id: projectId,
    })),
  );
  // Inserted one at a time so `created_sequence` follows role order.
  for (const agent of agents) {
    await transaction.insertInto('agents').values(agent).execute();
  }
  await transaction
    .updateTable('projects')
    .set({ fleet_created: true })
    .where('id', '=', projectId)
    .execute();
}

export function createFleet(database: Kysely<Database>): Fleet {
  async function requireProject(projectId: string) {
    const project = await database
      .selectFrom('projects')
      .select(['id', 'name', 'owner'])
      .where('id', '=', projectId)
      .executeTakeFirst();
    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }
    return project;
  }

  async function readRoles(projectId: string): Promise<FleetRole[]> {
    const [types, overrides, agents] = await Promise.all([
      database
        .selectFrom('agent_types')
        .select(['id', 'role', 'model', 'interactive', 'triggers'])
        .orderBy('position')
        .execute(),
      database
        .selectFrom('agent_type_overrides')
        .select(['agent_type_id', 'fields'])
        .where('project_id', '=', projectId)
        .execute(),
      database
        .selectFrom('agents')
        .select(['agent_type_id', 'name'])
        .where('project_id', '=', projectId)
        .orderBy('created_sequence')
        .execute(),
    ]);
    return types.map((type) => {
      const fields =
        overrides.find((override) => override.agent_type_id === type.id)
          ?.fields ?? {};
      return {
        interactive: type.interactive,
        model: fields.model ?? type.model,
        people: agents
          .filter((agent) => agent.agent_type_id === type.id)
          .map((agent) => agent.name),
        role: type.role,
        startMode: startModeOf(
          type.interactive,
          fields.triggers ?? type.triggers,
        ),
        typeId: type.id,
      };
    });
  }

  async function readPeople(
    projectId: string,
    agentId?: string,
  ): Promise<FleetPerson[]> {
    let query = database
      .selectFrom('agents')
      .innerJoin('agent_types', 'agent_types.id', 'agents.agent_type_id')
      .leftJoin('runs', (join) =>
        join
          .onRef('runs.agent_id', '=', 'agents.id')
          .on('runs.status', '=', 'active'),
      )
      .leftJoin('work_items', 'work_items.holder_run_id', 'runs.id')
      .select([
        'agents.id',
        'agents.name',
        'agents.enabled',
        'agents.agent_type_id',
        'agent_types.role',
        'runs.id as run_id',
        'work_items.id as item_id',
        'work_items.title as item_title',
      ])
      .where('agents.project_id', '=', projectId)
      .orderBy('agent_types.position')
      .orderBy('agents.created_sequence');
    if (agentId) {
      query = query.where('agents.id', '=', agentId);
    }
    const rows = await query.execute();
    const people = new Map<string, FleetPerson>();
    for (const row of rows) {
      const existing = people.get(row.id);
      if (existing && existing.activity.kind !== 'available') {
        continue;
      }
      people.set(row.id, {
        activity:
          row.item_id && row.item_title !== null
            ? {
                item: { id: row.item_id, title: row.item_title },
                kind: 'working',
              }
            : { kind: 'available' },
        enabled: row.enabled,
        id: row.id,
        name: row.name,
        role: row.role,
        running: row.run_id !== null || existing?.running === true,
        typeId: row.agent_type_id,
      });
    }
    return [...people.values()];
  }

  async function readPerson(agentId: string): Promise<FleetPerson> {
    const agent = await database
      .selectFrom('agents')
      .select('project_id')
      .where('id', '=', agentId)
      .executeTakeFirst();
    const [person] = agent ? await readPeople(agent.project_id, agentId) : [];
    if (!person) {
      throw new AgentNotFoundError(agentId);
    }
    return person;
  }

  async function withNameUniqueness<T>(
    name: string,
    write: () => Promise<T>,
  ): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateAgentNameError(name);
      }
      throw error;
    }
  }

  return {
    async addAgent(projectId, input) {
      await requireProject(projectId);
      const name = agentName(input.name);
      const type = await database
        .selectFrom('agent_types')
        .select('id')
        .where('id', '=', input.typeId)
        .executeTakeFirst();
      if (!type) {
        throw new AgentTypeNotFoundError(input.typeId);
      }
      const id = crypto.randomUUID();
      await withNameUniqueness(name, () =>
        database
          .insertInto('agents')
          .values({
            agent_type_id: type.id,
            id,
            name,
            project_id: projectId,
          })
          .execute(),
      );
      return readPerson(id);
    },

    async createMissingFleets() {
      const projects = await database
        .selectFrom('projects')
        .select('id')
        .where('fleet_created', '=', false)
        .execute();
      let created = 0;
      for (const project of projects) {
        await database.transaction().execute(async (transaction) => {
          const pending = await transaction
            .selectFrom('projects')
            .select('id')
            .where('id', '=', project.id)
            .where('fleet_created', '=', false)
            .forUpdate()
            .executeTakeFirst();
          if (pending) {
            await createDefaultFleet(transaction, project.id);
            created += 1;
          }
        });
      }
      return created;
    },

    async read(projectId) {
      const project = await requireProject(projectId);
      const [people, roles] = await Promise.all([
        readPeople(projectId),
        readRoles(projectId),
      ]);
      return { people, project, roles };
    },

    async removeAgent(agentId) {
      await database.transaction().execute(async (transaction) => {
        const agent = await transaction
          .selectFrom('agents')
          .select(['id', 'name'])
          .where('id', '=', agentId)
          .forUpdate()
          .executeTakeFirst();
        if (!agent) {
          throw new AgentNotFoundError(agentId);
        }
        const live = await transaction
          .selectFrom('runs')
          .select('id')
          .where('agent_id', '=', agentId)
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (live) {
          throw new AgentHoldsWorkError(agent.name);
        }
        await transaction
          .deleteFrom('agents')
          .where('id', '=', agentId)
          .execute();
      });
    },

    async saveRoleSettings(projectId, typeId, settings) {
      await requireProject(projectId);
      const type = await database
        .selectFrom('agent_types')
        .select(['id', 'model', 'interactive', 'triggers'])
        .where('id', '=', typeId)
        .executeTakeFirst();
      if (!type) {
        throw new AgentTypeNotFoundError(typeId);
      }
      if (!isAgentModel(settings.model)) {
        throw new InvalidRoleSettingsError('model');
      }
      const validStart = type.interactive
        ? settings.startMode === null
        : settings.startMode === 'ready' || settings.startMode === 'manual';
      if (!validStart) {
        throw new InvalidRoleSettingsError('startMode');
      }

      const fields: { model?: AgentModel; triggers?: AgentTrigger[] } = {};
      if (settings.model !== type.model) {
        fields.model = settings.model;
      }
      if (
        !type.interactive &&
        settings.startMode !== startModeOf(false, type.triggers)
      ) {
        const triggers =
          settings.startMode === 'ready' ? readyTriggers : manualTriggers;
        if (!sameTriggers(triggers, type.triggers)) {
          fields.triggers = triggers;
        }
      }

      if (Object.keys(fields).length === 0) {
        await database
          .deleteFrom('agent_type_overrides')
          .where('project_id', '=', projectId)
          .where('agent_type_id', '=', typeId)
          .execute();
      } else {
        const stored: AgentTypeOverrideFields = fields;
        await database
          .insertInto('agent_type_overrides')
          .values({
            agent_type_id: typeId,
            fields: JSON.stringify(
              stored,
            ) as unknown as AgentTypeOverrideFields,
            project_id: projectId,
          })
          .onConflict((conflict) =>
            conflict.columns(['project_id', 'agent_type_id']).doUpdateSet({
              fields: JSON.stringify(
                stored,
              ) as unknown as AgentTypeOverrideFields,
            }),
          )
          .execute();
      }

      const role = (await readRoles(projectId)).find(
        (candidate) => candidate.typeId === typeId,
      );
      if (!role) {
        throw new AgentTypeNotFoundError(typeId);
      }
      return role;
    },

    async seedAgentTypes(definitions) {
      for (const [position, definition] of definitions.entries()) {
        await database
          .insertInto('agent_types')
          .values({
            default_count: definition.defaultCount,
            default_names: JSON.stringify(
              definition.names,
            ) as unknown as string[],
            definition: JSON.stringify(definition),
            id: crypto.randomUUID(),
            instructions: definition.instructions,
            interactive: definition.interactive,
            model: definition.model,
            name: definition.name,
            position,
            role: definition.role,
            triggers: JSON.stringify(
              definition.triggers,
            ) as unknown as AgentTrigger[],
          })
          .onConflict((conflict) => conflict.column('name').doNothing())
          .execute();
      }
    },

    async updateAgent(agentId, changes) {
      const agent = await database
        .selectFrom('agents')
        .select('id')
        .where('id', '=', agentId)
        .executeTakeFirst();
      if (!agent) {
        throw new AgentNotFoundError(agentId);
      }
      const values: { enabled?: boolean; name?: string } = {};
      if (changes.name !== undefined) {
        values.name = agentName(changes.name);
      }
      if (changes.enabled !== undefined) {
        if (typeof changes.enabled !== 'boolean') {
          throw new InvalidAgentChangeError();
        }
        values.enabled = changes.enabled;
      }
      if (Object.keys(values).length > 0) {
        await withNameUniqueness(values.name ?? '', () =>
          database
            .updateTable('agents')
            .set(values)
            .where('id', '=', agentId)
            .execute(),
        );
      }
      return readPerson(agentId);
    },
  };
}
