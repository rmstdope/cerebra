import { type Generated, Kysely } from 'kysely';
import { Pool } from 'pg';

import type { AgentModel, AgentRole, AgentTrigger } from './agent-types.js';
import type { Priority, WaitingKind, WorkItemState } from './lifecycle.js';
import { SchemaScopedPostgresDialect } from './schema-introspection.js';

export interface Database {
  agent_type_overrides: {
    agent_type_id: string;
    fields: AgentTypeOverrideFields;
    project_id: string;
  };
  agent_types: {
    created_at: Generated<Date>;
    default_count: number;
    default_names: string[];
    definition: unknown;
    id: string;
    instructions: string;
    interactive: boolean;
    model: AgentModel;
    name: string;
    position: number;
    role: AgentRole;
    triggers: AgentTrigger[];
  };
  agents: {
    agent_type_id: string;
    created_at: Generated<Date>;
    created_sequence: Generated<string>;
    enabled: Generated<boolean>;
    id: string;
    name: string;
    project_id: string;
  };
  agent_credentials: {
    agent_type: string;
    credential_name: string;
    delivery: 'environment' | 'file';
    destination: string;
    id: Generated<string>;
    project_id: string;
  };
  authentication_configuration: {
    id: Generated<boolean>;
    user_id: string;
  };
  credentials: {
    created_at: Generated<Date>;
    id: string;
    key_ciphertext: string;
    key_iv: string;
    key_tag: string;
    last_used_at: Date | null;
    last_used_run_id: string | null;
    name: string;
    problem: 'undecryptable' | 'injection_failed' | null;
    project_id: string | null;
    updated_at: Generated<Date>;
    value_ciphertext: string;
    value_iv: string;
    value_tag: string;
  };
  lifecycle_events: {
    created_at: Generated<Date>;
    id: Generated<number>;
    kind: string;
    payload: unknown;
    work_item_id: string;
  };
  runs: {
    agent_id: Generated<string | null>;
    agent_name: Generated<string | null>;
    container_id: Generated<string | null>;
    cost_usd: Generated<number>;
    created_at: Generated<Date>;
    ended_at: Generated<Date | null>;
    failure: Generated<string | null>;
    id: string;
    project_id: Generated<string | null>;
    role:
      | 'assistant'
      | 'groomer'
      | 'designer'
      | 'builder'
      | 'reviewer'
      | 'verifier';
    session_id: Generated<string | null>;
    start_failed: Generated<boolean>;
    status: Generated<RunState>;
    token_hash: Generated<string | null>;
  };
  run_events: {
    created_at: Generated<Date>;
    event: unknown;
    id: Generated<string>;
    position: number;
    run_id: string;
  };
  sessions: {
    created_at: Generated<Date>;
    expires_at: Date;
    token_hash: string;
    user_id: string;
  };
  users: {
    created_at: Generated<Date>;
    id: string;
    password_hash: string;
  };
  work_item_history: {
    actor_role: string;
    actor_run_id: string | null;
    created_at: Generated<Date>;
    from_state: string;
    id: Generated<number>;
    reason: string | null;
    to_state: string;
    work_item_id: string;
  };
  work_item_records: {
    created_at: Generated<Date>;
    id: Generated<number>;
    kind: string;
    payload: unknown;
    work_item_id: string;
  };
  work_items: {
    attempts: number;
    created_at: Generated<Date>;
    description: string;
    filed_sequence: Generated<string>;
    holder_run_id: string | null;
    id: string;
    priority: Priority | null;
    project_id: string;
    return_state: WorkItemState | null;
    rounds: number;
    state: WorkItemState;
    title: string;
    updated_at: Generated<Date>;
    waiting_kind: WaitingKind | null;
    waiting_reason: string | null;
  };
  work_item_comments: {
    body: string;
    created_at: Generated<Date>;
    id: Generated<number>;
    work_item_id: string;
  };
  projects: {
    created_at: Generated<Date>;
    default_branch: Generated<string>;
    design_enabled: Generated<boolean>;
    fleet_created: Generated<boolean>;
    grooming_enabled: Generated<boolean>;
    github_token_ciphertext: Generated<string>;
    github_token_iv: Generated<string>;
    github_token_tag: Generated<string>;
    id: string;
    key_prefix: Generated<string>;
    max_attempts: Generated<number>;
    max_concurrent_runs: Generated<number>;
    max_rounds: Generated<number>;
    name: string;
    owner: Generated<string>;
    remote: Generated<string>;
    verify_enabled: Generated<boolean>;
  };
}

export type RunState =
  'starting' | 'active' | 'awaiting_input' | 'finished' | 'failed';

export type LiveRunState = Extract<
  RunState,
  'starting' | 'active' | 'awaiting_input'
>;

export const liveRunStates: readonly LiveRunState[] = [
  'starting',
  'active',
  'awaiting_input',
];

export interface AgentTypeOverrideFields {
  readonly model?: AgentModel;
  readonly triggers?: AgentTrigger[];
}

function searchPathOption(schema: string | undefined): string | undefined {
  if (!schema) {
    return undefined;
  }

  if (!/^[a-z][a-z0-9_]*$/.test(schema)) {
    throw new Error(`Invalid PostgreSQL schema name: ${schema}`);
  }

  return `-c search_path=${schema},public`;
}

export function createDatabase(
  databaseUrl: string,
  schema?: string,
): Kysely<Database> {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  return new Kysely<Database>({
    dialect: new SchemaScopedPostgresDialect({
      pool: new Pool({
        connectionString: databaseUrl,
        options: searchPathOption(schema),
      }),
    }),
  });
}
