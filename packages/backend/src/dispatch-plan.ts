import type { Priority } from './lifecycle.js';

/** What the dispatcher knows about one project when it plans (spec §3, §5.4). */
export interface PlanProject {
  readonly id: string;
  readonly limit: number;
  readonly paused: boolean;
  /** Live runs in the project, however they were started. */
  readonly running: number;
}

/** One agent type as it applies in one project, after that project's overrides. */
export interface PlanType {
  /** The service whose credential this type cannot start without, when one is missing. */
  readonly credentialProblem: string | null;
  readonly id: string;
  readonly projectId: string;
  readonly role: string;
  readonly serves: {
    readonly excludeTypes?: readonly string[];
    readonly states?: readonly string[];
    readonly types?: readonly string[];
  };
  readonly stateTriggered: boolean;
}

export interface PlanAgent {
  /** Enabled, with no live run. */
  readonly free: boolean;
  readonly id: string;
  readonly projectId: string;
  readonly typeId: string;
}

/** An unheld item in a queue state. */
export interface PlanItem {
  readonly claimableSince: Date;
  readonly id: string;
  readonly priority: Priority | null;
  readonly projectId: string;
  readonly state: string;
  readonly type: string | null;
}

export interface PlanSnapshot {
  readonly agents: readonly PlanAgent[];
  readonly instanceLimit: number;
  readonly instanceRunning: number;
  readonly items: readonly PlanItem[];
  readonly projects: readonly PlanProject[];
  readonly types: readonly PlanType[];
}

export type WaitingReason =
  | { readonly kind: 'paused' }
  | { readonly kind: 'credential_missing'; readonly service: string }
  | {
      readonly kind: 'project_limit' | 'instance_limit';
      readonly limit: number;
      readonly running: number;
    }
  | { readonly kind: 'no_free_agent'; readonly role: string };

export interface Pairing {
  readonly agentId: string;
  readonly itemId: string;
  readonly projectId: string;
  readonly typeId: string;
}

export interface DispatchPlan {
  /** In the order the instance ceiling admitted them. */
  readonly pairings: readonly Pairing[];
  /** Every item a state-triggered type serves that this plan does not start, and why. */
  readonly waiting: readonly {
    readonly itemId: string;
    readonly reason: WaitingReason;
  }[];
}

const priorityRank: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

function offerOrder(left: PlanItem, right: PlanItem): number {
  const rank = (item: PlanItem) =>
    item.priority === null ? 4 : priorityRank[item.priority];
  return (
    rank(left) - rank(right) ||
    left.claimableSince.getTime() - right.claimableSince.getTime() ||
    left.id.localeCompare(right.id)
  );
}

/** Items carry no type yet, so a type that serves only named types serves nothing. */
function serves(type: PlanType, item: PlanItem): boolean {
  if (!(type.serves.states ?? []).includes(item.state)) return false;
  if (type.serves.types !== undefined) {
    return item.type !== null && type.serves.types.includes(item.type);
  }
  return (
    item.type === null || !(type.serves.excludeTypes ?? []).includes(item.type)
  );
}

type PendingReason =
  | { readonly kind: 'paused' }
  | { readonly kind: 'credential_missing'; readonly service: string }
  | { readonly kind: 'project_limit' }
  | { readonly kind: 'instance_limit' }
  | { readonly kind: 'no_free_agent'; readonly role: string };

/**
 * Pairs free agents with claimable items (architecture §6): within a project by priority then
 * age, up to its limit; across projects by when items became claimable, up to the instance
 * ceiling (D30). Every served item left unstarted gets one reason, the first that applies of:
 * paused, credential missing, project limit, Cerebra-wide limit, no free agent.
 */
export function planDispatch(snapshot: PlanSnapshot): DispatchPlan {
  const reasons = new Map<string, PendingReason>();
  const proposals = new Map<string, { item: PlanItem; pairing: Pairing }[]>();
  const projectOf = new Map(
    snapshot.projects.map((project) => [project.id, project]),
  );
  const admittedIn = new Map<string, number>();

  for (const project of snapshot.projects) {
    const types = snapshot.types.filter(
      (type) => type.projectId === project.id && type.stateTriggered,
    );
    const free = new Map(
      types.map((type) => [
        type.id,
        snapshot.agents.filter(
          (agent) =>
            agent.typeId === type.id &&
            agent.projectId === project.id &&
            agent.free,
        ),
      ]),
    );
    const items = snapshot.items
      .filter((item) => item.projectId === project.id)
      .sort(offerOrder);
    let slots = Math.max(0, project.limit - project.running);
    const queue: { item: PlanItem; pairing: Pairing }[] = [];

    for (const item of items) {
      const serving = types.filter((type) => serves(type, item));
      if (serving.length === 0) continue;
      if (project.paused) {
        reasons.set(item.id, { kind: 'paused' });
        continue;
      }
      const usable = serving.filter((type) => type.credentialProblem === null);
      if (usable.length === 0) {
        reasons.set(item.id, {
          kind: 'credential_missing',
          service: serving[0].credentialProblem ?? '',
        });
        continue;
      }
      if (slots === 0) {
        reasons.set(item.id, { kind: 'project_limit' });
        continue;
      }
      const type = usable.find(
        (candidate) => (free.get(candidate.id) ?? []).length > 0,
      );
      const agent = type === undefined ? undefined : free.get(type.id)?.shift();
      if (type === undefined || agent === undefined) {
        reasons.set(item.id, { kind: 'no_free_agent', role: usable[0].role });
        continue;
      }
      slots -= 1;
      queue.push({
        item,
        pairing: {
          agentId: agent.id,
          itemId: item.id,
          projectId: project.id,
          typeId: type.id,
        },
      });
    }
    proposals.set(project.id, queue);
  }

  let instanceSlots = Math.max(
    0,
    snapshot.instanceLimit - snapshot.instanceRunning,
  );
  const pairings: Pairing[] = [];
  for (;;) {
    let next: { item: PlanItem; pairing: Pairing }[] | undefined;
    for (const queue of proposals.values()) {
      if (
        queue.length > 0 &&
        (next === undefined ||
          queue[0].item.claimableSince.getTime() <
            next[0].item.claimableSince.getTime())
      ) {
        next = queue;
      }
    }
    if (next === undefined) break;
    const proposal = next.shift();
    if (proposal === undefined) break;
    if (instanceSlots === 0) {
      reasons.set(proposal.item.id, { kind: 'instance_limit' });
      continue;
    }
    instanceSlots -= 1;
    pairings.push(proposal.pairing);
    admittedIn.set(
      proposal.pairing.projectId,
      (admittedIn.get(proposal.pairing.projectId) ?? 0) + 1,
    );
  }

  const instanceRunning = snapshot.instanceRunning + pairings.length;
  const instanceFull = instanceSlots === 0;
  const waiting = snapshot.items
    .filter((item) => reasons.has(item.id))
    .map((item) => {
      const pending = reasons.get(item.id) as PendingReason;
      const project = projectOf.get(item.projectId) as PlanProject;
      let reason: WaitingReason;
      const projectRunning =
        project.running + (admittedIn.get(project.id) ?? 0);
      // Slots proposals held until the instance ceiling refused them were never really used.
      const projectFull = projectRunning >= project.limit;
      if (pending.kind === 'project_limit' && projectFull) {
        reason = {
          kind: 'project_limit',
          limit: project.limit,
          running: projectRunning,
        };
      } else if (
        pending.kind === 'instance_limit' ||
        pending.kind === 'project_limit' ||
        (pending.kind === 'no_free_agent' && instanceFull)
      ) {
        reason = {
          kind: 'instance_limit',
          limit: snapshot.instanceLimit,
          running: instanceRunning,
        };
      } else {
        reason = pending;
      }
      return { itemId: item.id, reason };
    });

  return { pairings, waiting };
}
