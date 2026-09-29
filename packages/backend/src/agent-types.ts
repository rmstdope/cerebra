import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const agentRoles = [
  'assistant',
  'groomer',
  'designer',
  'producer',
  'bugfixer',
  'reviewer',
] as const;
export type AgentRole = (typeof agentRoles)[number];

export const modelOptions = [
  { id: 'opus', label: 'Claude Opus' },
  { id: 'sonnet', label: 'Claude Sonnet' },
  { id: 'haiku', label: 'Claude Haiku' },
] as const;
export type AgentModel = (typeof modelOptions)[number]['id'];

export type AgentTrigger = { readonly kind: 'navigator' | 'state' };

export interface AgentTypeDefinition {
  readonly backend: 'claude';
  readonly defaultCount: number;
  readonly effort: string;
  readonly idleTimeoutSeconds: number;
  readonly image: string;
  readonly instructions: string;
  readonly interactive: boolean;
  readonly model: AgentModel;
  readonly name: string;
  readonly names: readonly string[];
  readonly network: string;
  readonly resources: Readonly<Record<string, unknown>>;
  readonly role: AgentRole;
  readonly secrets: readonly string[];
  readonly serves: Readonly<Record<string, unknown>>;
  readonly skills: readonly string[];
  readonly tools: readonly string[];
  readonly triggers: readonly AgentTrigger[];
}

/** Where the shipped definitions live, from both `src` and `dist`. */
export const agentTypesDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'agent-types',
);

export class InvalidAgentTypeError extends Error {
  public constructor(file: string, field: string) {
    super(`The agent type in ${file} has an invalid ${field}.`);
    this.name = 'InvalidAgentTypeError';
  }
}

export function isAgentModel(value: unknown): value is AgentModel {
  return modelOptions.some((option) => option.id === value);
}

export function isAgentTriggers(value: unknown): value is AgentTrigger[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (trigger: unknown) =>
        typeof trigger === 'object' &&
        trigger !== null &&
        ((trigger as { kind?: unknown }).kind === 'navigator' ||
          (trigger as { kind?: unknown }).kind === 'state'),
    )
  );
}

function isStringList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string' && entry.trim() !== '')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseAgentTypeDefinition(
  value: unknown,
  instructions: string,
  file: string,
): AgentTypeDefinition {
  const refuse = (field: string): never => {
    throw new InvalidAgentTypeError(file, field);
  };
  if (!isRecord(value)) refuse('definition');
  const body = value as Record<string, unknown>;
  const text = (field: string): string =>
    typeof body[field] === 'string' && body[field].trim() !== ''
      ? body[field]
      : refuse(field);

  const name = text('name');
  const role = text('role');
  if (!(agentRoles as readonly string[]).includes(role)) refuse('role');
  if (body.backend !== 'claude') refuse('backend');
  if (!isAgentModel(body.model)) refuse('model');
  const effort = text('effort');
  if (typeof body.interactive !== 'boolean') refuse('interactive');
  if (!isAgentTriggers(body.triggers)) refuse('triggers');
  if (!isRecord(body.serves)) refuse('serves');
  if (!isStringList(body.skills)) refuse('skills');
  if (!isStringList(body.tools)) refuse('tools');
  if (!isStringList(body.secrets)) refuse('secrets');
  const image = text('image');
  if (!isRecord(body.resources)) refuse('resources');
  const network = text('network');
  if (
    typeof body.idleTimeoutSeconds !== 'number' ||
    !Number.isInteger(body.idleTimeoutSeconds) ||
    body.idleTimeoutSeconds <= 0
  ) {
    refuse('idleTimeoutSeconds');
  }
  if (
    typeof body.defaultCount !== 'number' ||
    !Number.isInteger(body.defaultCount) ||
    body.defaultCount < 0
  ) {
    refuse('defaultCount');
  }
  const defaultCount = body.defaultCount as number;
  if (
    !isStringList(body.names) ||
    body.names.length < defaultCount ||
    new Set(body.names.map((entry) => entry.toLowerCase())).size !==
      body.names.length
  ) {
    refuse('names');
  }
  if (instructions.trim() === '') refuse('instructions');

  return {
    backend: 'claude',
    defaultCount,
    effort,
    idleTimeoutSeconds: body.idleTimeoutSeconds as number,
    image,
    instructions,
    interactive: body.interactive as boolean,
    model: body.model as AgentModel,
    name,
    names: body.names as string[],
    network,
    resources: body.resources as Record<string, unknown>,
    role: role as AgentRole,
    secrets: body.secrets as string[],
    serves: body.serves as Record<string, unknown>,
    skills: body.skills as string[],
    tools: body.tools as string[],
    triggers: (body.triggers as AgentTrigger[]).map(({ kind }) => ({ kind })),
  };
}

/** Reads every `<name>.json` with its `<name>.md` instructions, in role order. */
export async function readAgentTypeDefinitions(
  directory: string,
): Promise<AgentTypeDefinition[]> {
  const files = (await readdir(directory))
    .filter((file) => file.endsWith('.json'))
    .sort();
  const definitions: AgentTypeDefinition[] = [];
  for (const file of files) {
    const instructionsFile = file.replace(/\.json$/, '.md');
    const definition = JSON.parse(
      await readFile(join(directory, file), 'utf8'),
    ) as unknown;
    let instructions: string;
    try {
      instructions = await readFile(join(directory, instructionsFile), 'utf8');
    } catch {
      throw new InvalidAgentTypeError(
        `${file} (missing ${instructionsFile})`,
        'instructions',
      );
    }
    definitions.push(parseAgentTypeDefinition(definition, instructions, file));
  }
  return definitions.sort(
    (left, right) =>
      agentRoles.indexOf(left.role) - agentRoles.indexOf(right.role),
  );
}
