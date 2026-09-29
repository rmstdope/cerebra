import { type Generated, Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import type { Priority, WaitingKind, WorkItemState } from './lifecycle.js';

export interface Database {
  authentication_configuration: {
    id: Generated<boolean>;
    user_id: string;
  };
  lifecycle_events: {
    created_at: Generated<Date>;
    id: Generated<number>;
    kind: string;
    payload: unknown;
    work_item_id: string;
  };
  runs: {
    created_at: Generated<Date>;
    id: string;
    role: 'groomer' | 'designer' | 'builder' | 'reviewer' | 'verifier';
    status: 'active' | 'ended';
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
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: databaseUrl,
        options: searchPathOption(schema),
      }),
    }),
  });
}
