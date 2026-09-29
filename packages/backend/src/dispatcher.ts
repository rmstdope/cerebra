import { sql, type Kysely, type Transaction } from 'kysely';

import type { AgentRole, AgentTrigger } from './agent-types.js';
import { claimForRun, ProjectNotFoundError } from './board.js';
import { loadFirstMessage } from './first-message.js';
import {
  agentGitHubCredentialName,
  modelCredentialName,
  type CredentialService,
} from './credentials.js';
import { liveRunStates, type Database } from './database.js';
import {
  planDispatch,
  type Pairing,
  type PlanSnapshot,
  type WaitingReason,
} from './dispatch-plan.js';
import { createRunToken } from './runner-gateway.js';
import { isUuid } from './runs.js';
import { isUniqueViolation, runRoleOf } from './supervisor.js';

/** A run the dispatcher has claimed an item for, ready for the supervisor to start. */
export interface DispatchedRun {
  readonly agentId: string;
  readonly firstMessage: string;
  readonly runId: string;
  readonly token: string;
}

export interface AutomaticStartStatus {
  readonly limit: number;
  readonly paused: boolean;
  readonly running: number;
  readonly waiting: readonly {
    readonly itemId: string;
    readonly reason: WaitingReason;
  }[];
}

export interface DispatcherOptions {
  readonly database: Kysely<Database>;
  readonly credentials: Pick<CredentialService, 'problemsFor'>;
  /** Starts a claimed run's container; a failure it cannot start ends the run itself. */
  readonly launch: (run: DispatchedRun) => Promise<void>;
  readonly log?: (message: string) => void;
  /** How long an agent whose last run failed to start is left alone, so a repeating fault cannot loop. */
  readonly failureCooloffMs?: number;
}

export interface Dispatcher {
  /** One pass over every project: starts what may start and logs why the rest waits. */
  dispatch(): Promise<void>;
  /** Asks for a pass; nudges during a pass are folded into one more. */
  nudge(): void;
  /** Settles once no pass is running or asked for. */
  idle(): Promise<void>;
  /** What the board shows: the project's pause, its runs against its limit, and each wait. */
  status(projectId: string): Promise<AutomaticStartStatus>;
}

/** Serialises every pairing's limit check and claim across dispatchers. */
export const dispatchLockKey = 7_294_130_002;

const serviceNames: Record<string, string> = {
  [agentGitHubCredentialName]: 'GitHub',
  [modelCredentialName]: 'Claude',
};

function describe(reason: WaitingReason): string {
  switch (reason.kind) {
    case 'paused':
      return 'automatic starts are paused';
    case 'credential_missing':
      return `${reason.service} credential missing`;
    case 'project_limit':
      return 'project limit reached';
    case 'instance_limit':
      return 'Cerebra-wide limit reached';
    case 'no_free_agent':
      return `no ${reason.role} is free`;
  }
}

interface TypeDefinition {
  readonly serves?: PlanSnapshot['types'][number]['serves'];
}

class PairingRefused extends Error {}

function parsed<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

async function liveCount(
  database: Kysely<Database> | Transaction<Database>,
  projectId?: string,
): Promise<number> {
  let query = database
    .selectFrom('runs')
    .select(sql<number>`count(*)::int`.as('count'))
    .where('status', 'in', liveRunStates);
  if (projectId !== undefined) {
    query = query.where('project_id', '=', projectId);
  }
  return (await query.executeTakeFirstOrThrow()).count;
}

/** Starts runs for state triggers (spec §5.4; architecture §6). */
export function createDispatcher({
  database,
  credentials,
  launch,
  log = () => {},
  failureCooloffMs = 5 * 60_000,
}: DispatcherOptions): Dispatcher {
  const lastRefusal = new Map<string, string>();
  let pass: Promise<void> | null = null;
  let again = false;

  async function snapshot(): Promise<PlanSnapshot> {
    const live = database
      .selectFrom('runs')
      .select(['project_id', 'agent_id'])
      .where('status', 'in', liveRunStates);
    const projects = await database
      .selectFrom('projects')
      .select(['id', 'max_concurrent_runs', 'automatic_starts_paused'])
      .orderBy('id')
      .execute();
    const liveRuns = await live.execute();
    const instance = await database
      .selectFrom('instance_settings')
      .select('max_concurrent_runs')
      .executeTakeFirstOrThrow();
    const types = await database
      .selectFrom('agent_types')
      .select(['id', 'name', 'role', 'triggers', 'definition'])
      .orderBy('position')
      .execute();
    const overrides = await database
      .selectFrom('agent_type_overrides')
      .select(['agent_type_id', 'project_id', 'fields'])
      .execute();
    const agents = await database
      .selectFrom('agents')
      .select(['id', 'project_id', 'agent_type_id', 'enabled'])
      .orderBy('created_sequence')
      .execute();
    const busy = new Set(liveRuns.map((run) => run.agent_id));
    // An agent whose latest run failed to start is left alone for a while (a failed start is
    // created and ended within moments, so only recent runs need reading).
    const latestRuns = await database
      .selectFrom('runs')
      .select(['agent_id', 'start_failed'])
      .where('agent_id', 'is not', null)
      .where('created_at', '>', new Date(Date.now() - failureCooloffMs))
      .distinctOn('agent_id')
      .orderBy('agent_id')
      .orderBy('created_at', 'desc')
      .execute();
    const cooling = new Set(
      latestRuns.filter((run) => run.start_failed).map((run) => run.agent_id),
    );

    const planTypes: PlanSnapshot['types'][number][] = [];
    const queueStates = new Set<string>();
    for (const project of projects) {
      for (const type of types) {
        const fields = overrides.find(
          (row) =>
            row.agent_type_id === type.id && row.project_id === project.id,
        )?.fields;
        const triggers = parsed<AgentTrigger[]>(
          parsed<{ triggers?: AgentTrigger[] } | null>(fields)?.triggers ??
            type.triggers,
        );
        const stateTriggered = triggers.some(
          (trigger) => trigger.kind === 'state',
        );
        const serves = parsed<TypeDefinition>(type.definition).serves ?? {};
        if (stateTriggered) {
          for (const state of serves.states ?? []) queueStates.add(state);
        }
        const problems = stateTriggered
          ? await credentials.problemsFor({
              agentType: type.name,
              projectId: project.id,
            })
          : [];
        planTypes.push({
          credentialProblem:
            problems.length === 0
              ? null
              : (serviceNames[problems[0]] ?? problems[0]),
          id: `${project.id}:${type.id}`,
          projectId: project.id,
          role: type.role,
          serves,
          stateTriggered,
        });
      }
    }

    const items =
      queueStates.size === 0
        ? []
        : await database
            .selectFrom('work_items')
            .select([
              'id',
              'project_id',
              'priority',
              'state',
              'type',
              'updated_at',
            ])
            .where('holder_run_id', 'is', null)
            .where('state', 'in', [...queueStates] as never[])
            .orderBy('updated_at')
            .orderBy('id')
            .execute();

    return {
      agents: agents.map((agent) => ({
        free: agent.enabled && !busy.has(agent.id) && !cooling.has(agent.id),
        id: agent.id,
        projectId: agent.project_id,
        typeId: `${agent.project_id}:${agent.agent_type_id}`,
      })),
      instanceLimit: instance.max_concurrent_runs,
      instanceRunning: liveRuns.length,
      items: items.map((item) => ({
        claimableSince: item.updated_at,
        id: item.id,
        priority: item.priority,
        projectId: item.project_id,
        state: item.state,
        type: item.type,
      })),
      projects: projects.map((project) => ({
        id: project.id,
        limit: project.max_concurrent_runs,
        paused: project.automatic_starts_paused,
        running: liveRuns.filter((run) => run.project_id === project.id).length,
      })),
      types: planTypes,
    };
  }

  async function logDecision(values: {
    readonly agentId?: string;
    readonly decision: 'started' | 'refused';
    readonly itemId: string;
    readonly projectId: string;
    readonly reason: string;
    readonly runId?: string;
  }): Promise<void> {
    await database
      .insertInto('dispatch_log')
      .values({
        agent_id: values.agentId ?? null,
        decision: values.decision,
        project_id: values.projectId,
        reason: values.reason,
        run_id: values.runId ?? null,
        work_item_id: values.itemId,
      })
      .execute();
  }

  /** Claims the item and inserts the run in one transaction, rechecking what the plan assumed. */
  async function start(pairing: Pairing): Promise<DispatchedRun | null> {
    const { hash, token } = createRunToken();
    try {
      const started = await database
        .transaction()
        .execute(async (transaction) => {
          await sql`select pg_advisory_xact_lock(${dispatchLockKey})`.execute(
            transaction,
          );
          const project = await transaction
            .selectFrom('projects')
            .select(['max_concurrent_runs', 'automatic_starts_paused'])
            .where('id', '=', pairing.projectId)
            .executeTakeFirst();
          const instance = await transaction
            .selectFrom('instance_settings')
            .select('max_concurrent_runs')
            .executeTakeFirstOrThrow();
          if (project === undefined || project.automatic_starts_paused) {
            throw new PairingRefused('automatic starts are paused');
          }
          if (
            (await liveCount(transaction, pairing.projectId)) >=
            project.max_concurrent_runs
          ) {
            throw new PairingRefused('project limit reached');
          }
          if ((await liveCount(transaction)) >= instance.max_concurrent_runs) {
            throw new PairingRefused('Cerebra-wide limit reached');
          }
          const agent = await transaction
            .selectFrom('agents')
            .innerJoin('agent_types', 'agent_types.id', 'agents.agent_type_id')
            .select(['agents.enabled', 'agents.name', 'agent_types.role'])
            .where('agents.id', '=', pairing.agentId)
            .executeTakeFirst();
          const busy = await transaction
            .selectFrom('runs')
            .select('id')
            .where('agent_id', '=', pairing.agentId)
            .where('status', 'in', liveRunStates)
            .executeTakeFirst();
          if (agent === undefined || !agent.enabled || busy !== undefined) {
            throw new PairingRefused('the agent is no longer free');
          }
          const runId = crypto.randomUUID();
          const role = runRoleOf(agent.role as AgentRole);
          if (role === 'assistant') {
            throw new PairingRefused('an assistant takes no work items');
          }
          await transaction
            .insertInto('runs')
            .values({
              agent_id: pairing.agentId,
              agent_name: agent.name,
              id: runId,
              project_id: pairing.projectId,
              role,
              status: 'starting',
              token_hash: hash,
            })
            .execute();
          const claimed = await claimForRun(
            transaction,
            pairing.itemId,
            runId,
            role,
          );
          if (!claimed.ok) throw new PairingRefused(claimed.reason);
          await transaction
            .insertInto('dispatch_log')
            .values({
              agent_id: pairing.agentId,
              decision: 'started',
              project_id: pairing.projectId,
              reason: `${agent.name} started on the item.`,
              run_id: runId,
              work_item_id: pairing.itemId,
            })
            .execute();
          return {
            agentId: pairing.agentId,
            firstMessage: await loadFirstMessage(
              transaction,
              pairing.itemId,
              role,
            ),
            runId,
            token,
          };
        });
      lastRefusal.delete(pairing.itemId);
      return started;
    } catch (error) {
      // A navigator's start can take the agent between the check and the insert.
      const refusal =
        error instanceof PairingRefused
          ? error.message
          : isUniqueViolation(error)
            ? 'the agent is no longer free'
            : null;
      if (refusal === null) throw error;
      await logDecision({
        agentId: pairing.agentId,
        decision: 'refused',
        itemId: pairing.itemId,
        projectId: pairing.projectId,
        reason: refusal,
      });
      return null;
    }
  }

  async function dispatch(): Promise<void> {
    const current = await snapshot();
    const plan = planDispatch(current);
    const projectOf = new Map(
      current.items.map((item) => [item.id, item.projectId]),
    );
    const waiting = new Set<string>();
    for (const { itemId, reason } of plan.waiting) {
      waiting.add(itemId);
      const text = describe(reason);
      if (lastRefusal.get(itemId) === text) continue;
      await logDecision({
        decision: 'refused',
        itemId,
        projectId: projectOf.get(itemId) ?? '',
        reason: text,
      });
      lastRefusal.set(itemId, text);
    }
    for (const itemId of lastRefusal.keys()) {
      if (!waiting.has(itemId)) lastRefusal.delete(itemId);
    }
    for (const pairing of plan.pairings) {
      const run = await start(pairing);
      if (run === null) continue;
      try {
        await launch(run);
      } catch (error) {
        log(
          `Run ${run.runId} could not start: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  function nudge(): void {
    if (pass !== null) {
      again = true;
      return;
    }
    pass = (async () => {
      do {
        again = false;
        try {
          await dispatch();
        } catch (error) {
          log(
            `The dispatcher could not finish a pass: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } while (again);
      pass = null;
    })();
  }

  return {
    dispatch,
    nudge,
    async idle() {
      while (pass !== null) await pass;
    },
    async status(projectId) {
      const project = isUuid(projectId)
        ? await database
            .selectFrom('projects')
            .select('id')
            .where('id', '=', projectId)
            .executeTakeFirst()
        : undefined;
      if (project === undefined) throw new ProjectNotFoundError(projectId);
      const current = await snapshot();
      const plan = planDispatch(current);
      const mine = current.projects.find((row) => row.id === projectId);
      if (mine === undefined) throw new ProjectNotFoundError(projectId);
      const items = new Set(
        current.items
          .filter((item) => item.projectId === projectId)
          .map((item) => item.id),
      );
      return {
        limit: mine.limit,
        paused: mine.paused,
        running: mine.running,
        waiting: plan.waiting.filter((entry) => items.has(entry.itemId)),
      };
    },
  };
}
