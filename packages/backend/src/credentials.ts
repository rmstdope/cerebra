import { posix } from 'node:path';
import { sql, type Kysely } from 'kysely';

import { ProjectNotFoundError } from './board.js';
import type { EnvelopeCipher } from './credential-cipher.js';
import type { Database } from './database.js';

export type CredentialScope = 'instance' | 'project';
export type CredentialDeliveryMethod = 'environment' | 'file';
export type CredentialProblem =
  'missing' | 'undecryptable' | 'injection_failed';

/** What every Claude run authenticates with, given without being declared. */
export const modelCredentialName = 'Claude sign-in token';
/** What a run pushes and opens pull requests with; never the backend's project token. */
export const agentGitHubCredentialName = 'GitHub access token';

export const builtInAgentTypes = [
  'groomer',
  'designer',
  'producer',
  'bugfixer',
  'reviewer',
  'assistant',
] as const;

const pushingAgentTypes: readonly string[] = [
  'producer',
  'bugfixer',
  'assistant',
];

export interface AgentCredentialDelivery {
  readonly credentialName: string;
  readonly delivery: CredentialDeliveryMethod;
  readonly destination: string;
}

export interface AgentCredentialEntry extends AgentCredentialDelivery {
  readonly builtIn: boolean;
  readonly needsAttention: boolean;
}

export interface AgentCredentialSettings {
  readonly agentType: string;
  readonly available: readonly string[];
  readonly entries: readonly AgentCredentialEntry[];
}

export interface CredentialRow {
  /** Null for a credential an agent needs that has not been saved. */
  readonly id: string | null;
  readonly lastUsedAt: string | null;
  readonly lastUsedRunId: string | null;
  readonly name: string;
  readonly needsAttention: boolean;
  readonly scope: CredentialScope;
  readonly usedBy: readonly string[];
  readonly usedByEveryAgent: boolean;
}

export interface CredentialAttention {
  readonly agentTypes: readonly string[];
  readonly everyAgent: boolean;
  readonly name: string;
  /** Null when the credential is missing. */
  readonly scope: CredentialScope | null;
}

export interface CredentialOverview {
  readonly attention: readonly CredentialAttention[];
  readonly instanceCredentials: readonly CredentialRow[];
  readonly project: { readonly id: string; readonly name: string } | null;
  readonly projectCredentials: readonly CredentialRow[];
}

export type RunCredentials =
  | {
      readonly credentialIds: readonly string[];
      readonly environment: Readonly<Record<string, string>>;
      readonly files: readonly {
        readonly path: string;
        readonly value: string;
      }[];
      readonly ok: true;
    }
  | {
      readonly ok: false;
      readonly problems: readonly {
        readonly name: string;
        readonly reason: CredentialProblem;
      }[];
    };

export interface SaveCredential {
  readonly name: string;
  readonly projectId?: string;
  readonly scope: CredentialScope;
  readonly value: string;
}

export interface CredentialService {
  agentCredentials(
    projectId: string,
    agentType: string,
  ): Promise<AgentCredentialSettings>;
  overview(projectId?: string): Promise<CredentialOverview>;
  /** The credentials `resolveForRun` would refuse a run of the type for, read without opening any. */
  problemsFor(request: {
    readonly agentType: string;
    readonly projectId: string;
  }): Promise<readonly string[]>;
  recordInjectionFailure(credentialId: string): Promise<void>;
  remove(credentialId: string): Promise<void>;
  resolveForRun(request: {
    readonly agentType: string;
    readonly projectId: string;
    readonly runId: string;
  }): Promise<RunCredentials>;
  save(input: SaveCredential): Promise<{ name: string; replaced: boolean }>;
  setAgentCredentials(
    projectId: string,
    agentType: string,
    deliveries: readonly AgentCredentialDelivery[],
  ): Promise<void>;
}

export class CredentialInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CredentialInputError';
  }
}

export class DuplicateDestinationError extends Error {
  public constructor(public readonly destination: string) {
    super(
      `“${destination}” is already used. Choose a different name or change the existing credential.`,
    );
    this.name = 'DuplicateDestinationError';
  }
}

export class CredentialNotFoundError extends Error {
  public constructor() {
    super('That credential no longer exists.');
    this.name = 'CredentialNotFoundError';
  }
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const variablePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const reservedVariablePrefix = 'CEREBRA_';
const checkoutPath = '/work';

export function builtInDeliveries(
  agentType: string,
): readonly AgentCredentialDelivery[] {
  return [
    {
      credentialName: modelCredentialName,
      delivery: 'environment',
      destination: 'CLAUDE_CODE_OAUTH_TOKEN',
    },
    ...(pushingAgentTypes.includes(agentType)
      ? [
          {
            credentialName: agentGitHubCredentialName,
            delivery: 'environment' as const,
            destination: 'GH_TOKEN',
          },
        ]
      : []),
  ];
}

function validateDestination(delivery: AgentCredentialDelivery): void {
  if (delivery.delivery === 'environment') {
    if (!variablePattern.test(delivery.destination)) {
      throw new CredentialInputError(
        'Use letters, numbers and underscores, starting with a letter.',
      );
    }
    if (delivery.destination.toUpperCase().startsWith(reservedVariablePrefix)) {
      throw new DuplicateDestinationError(delivery.destination);
    }
    return;
  }
  const path = delivery.destination;
  if (
    !path.startsWith('/') ||
    path.endsWith('/') ||
    path.split('/').includes('..') ||
    posix.normalize(path) !== path ||
    path === checkoutPath ||
    path.startsWith(`${checkoutPath}/`)
  ) {
    throw new CredentialInputError(
      'Use a full path outside /work, such as /run/secrets/token.',
    );
  }
}

interface StoredCredential {
  readonly id: string;
  readonly last_used_at: Date | null;
  readonly last_used_run_id: string | null;
  readonly name: string;
  readonly problem: 'undecryptable' | 'injection_failed' | null;
  readonly project_id: string | null;
}

function byName<T extends { readonly name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name);
}

export function createCredentialService(options: {
  readonly cipher: EnvelopeCipher;
  readonly database: Kysely<Database>;
}): CredentialService {
  const { cipher, database } = options;

  async function projectSummary(
    projectId: string,
  ): Promise<{ id: string; name: string }> {
    if (!uuidPattern.test(projectId)) {
      throw new ProjectNotFoundError(projectId);
    }
    const project = await database
      .selectFrom('projects')
      .select(['id', 'name', 'owner'])
      .where('id', '=', projectId)
      .executeTakeFirst();
    if (project === undefined) {
      throw new ProjectNotFoundError(projectId);
    }
    const owner = project.owner as string | null;
    return {
      id: project.id,
      name:
        owner === null || owner === ''
          ? project.name
          : `${owner}/${project.name}`,
    };
  }

  async function storedFor(
    projectId: string | undefined,
  ): Promise<StoredCredential[]> {
    return database
      .selectFrom('credentials')
      .select([
        'id',
        'last_used_at',
        'last_used_run_id',
        'name',
        'problem',
        'project_id',
      ])
      .where((eb) =>
        projectId === undefined
          ? eb('project_id', 'is', null)
          : eb.or([
              eb('project_id', 'is', null),
              eb('project_id', '=', projectId),
            ]),
      )
      .execute();
  }

  async function declaredFor(
    projectId: string | undefined,
    agentType?: string,
  ): Promise<
    {
      agent_type: string;
      credential_name: string;
      delivery: CredentialDeliveryMethod;
      destination: string;
    }[]
  > {
    if (projectId === undefined) {
      return [];
    }
    let query = database
      .selectFrom('agent_credentials')
      .select(['agent_type', 'credential_name', 'delivery', 'destination'])
      .where('project_id', '=', projectId);
    if (agentType !== undefined) {
      query = query.where('agent_type', '=', agentType);
    }
    return query.orderBy('id').execute();
  }

  async function deliveriesFor(projectId: string, agentType: string) {
    const declared = await declaredFor(projectId, agentType);
    return [
      ...builtInDeliveries(agentType),
      ...declared.map((row) => ({
        credentialName: row.credential_name,
        delivery: row.delivery,
        destination: row.destination,
      })),
    ];
  }

  function resolver(stored: readonly StoredCredential[]) {
    return (name: string): StoredCredential | undefined =>
      stored.find((row) => row.name === name && row.project_id !== null) ??
      stored.find((row) => row.name === name && row.project_id === null);
  }

  return {
    async agentCredentials(projectId, agentType) {
      await projectSummary(projectId);
      const stored = await storedFor(projectId);
      const resolve = resolver(stored);
      const declared = await declaredFor(projectId, agentType);
      const entry = (
        delivery: AgentCredentialDelivery,
        builtIn: boolean,
      ): AgentCredentialEntry => {
        const row = resolve(delivery.credentialName);
        return {
          builtIn,
          credentialName: delivery.credentialName,
          delivery: delivery.delivery,
          destination: delivery.destination,
          needsAttention: row === undefined || row.problem !== null,
        };
      };
      return {
        agentType,
        available: [...new Set(stored.map((row) => row.name))].sort((a, b) =>
          a.localeCompare(b),
        ),
        entries: [
          ...builtInDeliveries(agentType).map((delivery) =>
            entry(delivery, true),
          ),
          ...declared.map((row) =>
            entry(
              {
                credentialName: row.credential_name,
                delivery: row.delivery,
                destination: row.destination,
              },
              false,
            ),
          ),
        ],
      };
    },

    async overview(projectId) {
      const project =
        projectId === undefined ? null : await projectSummary(projectId);
      const stored = await storedFor(projectId);
      const resolve = resolver(stored);
      const declared = await declaredFor(projectId);
      const agentTypes = [
        ...new Set([
          ...builtInAgentTypes,
          ...declared.map((row) => row.agent_type),
        ]),
      ];
      const needs = new Map<string, Set<string>>();
      for (const agentType of agentTypes) {
        const names = [
          ...builtInDeliveries(agentType)
            .filter(
              (delivery) => delivery.credentialName !== modelCredentialName,
            )
            .map((delivery) => delivery.credentialName),
          ...declared
            .filter((row) => row.agent_type === agentType)
            .map((row) => row.credential_name),
        ];
        for (const name of names) {
          needs.set(name, (needs.get(name) ?? new Set()).add(agentType));
        }
      }
      const usersOf = (name: string): string[] =>
        [...(needs.get(name) ?? [])].sort((a, b) => a.localeCompare(b));

      const toRow = (row: StoredCredential): CredentialRow => {
        const inUse = resolve(row.name) === row;
        return {
          id: row.id,
          lastUsedAt: row.last_used_at?.toISOString() ?? null,
          lastUsedRunId: row.last_used_run_id,
          name: row.name,
          needsAttention: row.problem !== null,
          scope: row.project_id === null ? 'instance' : 'project',
          usedBy: inUse ? usersOf(row.name) : [],
          usedByEveryAgent: inUse && row.name === modelCredentialName,
        };
      };
      const missing = [modelCredentialName, ...needs.keys()]
        .filter((name, index, all) => all.indexOf(name) === index)
        .filter((name) => resolve(name) === undefined)
        .map((name): CredentialRow => ({
          id: null,
          lastUsedAt: null,
          lastUsedRunId: null,
          name,
          needsAttention: true,
          scope:
            name === modelCredentialName || project === null
              ? 'instance'
              : 'project',
          usedBy: usersOf(name),
          usedByEveryAgent: name === modelCredentialName,
        }));
      const rows = [...stored.map(toRow), ...missing];
      const attention: CredentialAttention[] = rows
        .filter((row) => row.needsAttention)
        .map((row) => ({
          agentTypes: row.usedBy,
          everyAgent: row.usedByEveryAgent,
          name: row.name,
          scope: row.id === null ? null : row.scope,
        }))
        .sort(byName);
      return {
        attention,
        instanceCredentials: rows
          .filter((row) => row.scope === 'instance')
          .sort(byName),
        project,
        projectCredentials: rows
          .filter((row) => row.scope === 'project')
          .sort(byName),
      };
    },

    async recordInjectionFailure(credentialId) {
      if (!uuidPattern.test(credentialId)) {
        throw new CredentialNotFoundError();
      }
      const result = await database
        .updateTable('credentials')
        .set({ problem: 'injection_failed' })
        .where('id', '=', credentialId)
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n) {
        throw new CredentialNotFoundError();
      }
    },

    async remove(credentialId) {
      if (!uuidPattern.test(credentialId)) {
        throw new CredentialNotFoundError();
      }
      const result = await database
        .deleteFrom('credentials')
        .where('id', '=', credentialId)
        .executeTakeFirst();
      if (result.numDeletedRows === 0n) {
        throw new CredentialNotFoundError();
      }
    },

    async problemsFor({ agentType, projectId }) {
      const resolve = resolver(await storedFor(projectId));
      const names = (await deliveriesFor(projectId, agentType))
        .map((delivery) => delivery.credentialName)
        .filter((name) => {
          const row = resolve(name);
          return row === undefined || row.problem !== null;
        });
      return [...new Set(names)];
    },

    async resolveForRun({ agentType, projectId, runId }) {
      const resolve = resolver(await storedFor(projectId));
      const deliveries = await deliveriesFor(projectId, agentType);
      const problems: { name: string; reason: CredentialProblem }[] = [];
      const environment: Record<string, string> = {};
      const files: { path: string; value: string }[] = [];
      const used = new Set<string>();
      for (const delivery of deliveries) {
        const row = resolve(delivery.credentialName);
        if (row === undefined) {
          problems.push({ name: delivery.credentialName, reason: 'missing' });
          continue;
        }
        if (row.problem !== null) {
          problems.push({ name: row.name, reason: row.problem });
          continue;
        }
        const sealed = await database
          .selectFrom('credentials')
          .select([
            'key_ciphertext',
            'key_iv',
            'key_tag',
            'value_ciphertext',
            'value_iv',
            'value_tag',
          ])
          .where('id', '=', row.id)
          .executeTakeFirstOrThrow();
        let value: string;
        try {
          value = cipher.open({
            keyCiphertext: sealed.key_ciphertext,
            keyIv: sealed.key_iv,
            keyTag: sealed.key_tag,
            valueCiphertext: sealed.value_ciphertext,
            valueIv: sealed.value_iv,
            valueTag: sealed.value_tag,
          });
        } catch {
          await database
            .updateTable('credentials')
            .set({ problem: 'undecryptable' })
            .where('id', '=', row.id)
            .execute();
          problems.push({ name: row.name, reason: 'undecryptable' });
          continue;
        }
        used.add(row.id);
        if (delivery.delivery === 'environment') {
          environment[delivery.destination] = value;
        } else {
          files.push({ path: delivery.destination, value });
        }
      }
      if (problems.length > 0) {
        return { ok: false, problems };
      }
      if (used.size > 0) {
        await database
          .updateTable('credentials')
          .set({ last_used_at: sql`now()`, last_used_run_id: runId })
          .where('id', 'in', [...used])
          .execute();
      }
      return { credentialIds: [...used], environment, files, ok: true };
    },

    async save({ name: rawName, projectId, scope, value }) {
      const name = rawName.trim();
      if (name.length === 0 || name.length > 100) {
        throw new CredentialInputError(
          'Use a clear name so you can recognise it later.',
        );
      }
      if (value.trim().length === 0) {
        throw new CredentialInputError('Paste the value.');
      }
      if (scope === 'project') {
        if (projectId === undefined) {
          throw new CredentialInputError('Choose where it applies.');
        }
        await projectSummary(projectId);
      }
      const owner = scope === 'project' ? projectId! : null;
      const sealed = cipher.seal(value);
      const columns = {
        key_ciphertext: sealed.keyCiphertext,
        key_iv: sealed.keyIv,
        key_tag: sealed.keyTag,
        value_ciphertext: sealed.valueCiphertext,
        value_iv: sealed.valueIv,
        value_tag: sealed.valueTag,
      };
      return database.transaction().execute(async (transaction) => {
        const existing = await transaction
          .selectFrom('credentials')
          .select('id')
          .where('name', '=', name)
          .where((eb) =>
            owner === null
              ? eb('project_id', 'is', null)
              : eb('project_id', '=', owner),
          )
          .forUpdate()
          .executeTakeFirst();
        if (existing !== undefined) {
          await transaction
            .updateTable('credentials')
            .set({ ...columns, problem: null, updated_at: sql`now()` })
            .where('id', '=', existing.id)
            .execute();
          return { name, replaced: true };
        }
        await transaction
          .insertInto('credentials')
          .values({
            ...columns,
            id: crypto.randomUUID(),
            name,
            project_id: owner,
          })
          .execute();
        return { name, replaced: false };
      });
    },

    async setAgentCredentials(projectId, agentType, deliveries) {
      await projectSummary(projectId);
      if (agentType.trim().length === 0) {
        throw new CredentialInputError('Choose an agent type.');
      }
      const taken = new Set(
        builtInDeliveries(agentType).map((delivery) => delivery.destination),
      );
      for (const delivery of deliveries) {
        if (delivery.credentialName.trim().length === 0) {
          throw new CredentialInputError('Choose a saved credential.');
        }
        if (
          delivery.delivery !== 'environment' &&
          delivery.delivery !== 'file'
        ) {
          throw new CredentialInputError('Choose how the agent receives it.');
        }
        validateDestination(delivery);
        if (taken.has(delivery.destination)) {
          throw new DuplicateDestinationError(delivery.destination);
        }
        taken.add(delivery.destination);
      }
      await database.transaction().execute(async (transaction) => {
        await transaction
          .deleteFrom('agent_credentials')
          .where('project_id', '=', projectId)
          .where('agent_type', '=', agentType)
          .execute();
        if (deliveries.length > 0) {
          await transaction
            .insertInto('agent_credentials')
            .values(
              deliveries.map((delivery) => ({
                agent_type: agentType,
                credential_name: delivery.credentialName.trim(),
                delivery: delivery.delivery,
                destination: delivery.destination,
                project_id: projectId,
              })),
            )
            .execute();
        }
      });
    },
  };
}
