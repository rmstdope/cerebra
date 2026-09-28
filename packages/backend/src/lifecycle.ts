export const workItemStates = [
  'new',
  'grooming_ready',
  'grooming',
  'design_ready',
  'designing',
  'build_ready',
  'building',
  'review_ready',
  'reviewing',
  'merging',
  'verify_ready',
  'verifying',
  'waiting',
  'split',
  'done',
  'cancelled',
] as const;

export type WorkItemState = (typeof workItemStates)[number];
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type LifecycleRole =
  | 'backend'
  | 'builder'
  | 'designer'
  | 'groomer'
  | 'navigator'
  | 'reviewer'
  | 'verifier';
export type WaitingKind = 'code_review' | 'escalation' | 'merge' | 'question';

export interface WorkItem {
  readonly attempts: number;
  readonly holderRunId: string | null;
  readonly priority: Priority | null;
  readonly rounds: number;
  readonly state: WorkItemState;
  readonly waitingKind: WaitingKind | null;
  readonly waitingReason: string | null;
  readonly returnState: WorkItemState | null;
}

export interface LifecycleContext {
  readonly stages: {
    readonly design: boolean;
    readonly grooming: boolean;
    readonly verify: boolean;
  };
  readonly supportsSplitting: boolean;
}

export interface TransitionRequest {
  readonly actor: {
    readonly role: LifecycleRole | string;
    readonly runId?: string;
  };
  readonly priority?: Priority;
  readonly record?: Readonly<Record<string, unknown>>;
  readonly reason?: string;
  readonly to: WorkItemState;
  readonly waiting?: {
    readonly kind: WaitingKind;
    readonly reason: string;
    readonly returnState: WorkItemState;
  };
}

export type TransitionResult =
  | {
      readonly effects: readonly LifecycleEffect[];
      readonly item: WorkItem;
      readonly ok: true;
    }
  | { readonly ok: false; readonly reason: string };

export type LifecycleEffect =
  | { readonly kind: 'history'; readonly reason: string | null }
  | {
      readonly kind: 'record';
      readonly record: Readonly<Record<string, unknown>>;
    };

interface TransitionRule {
  readonly from: WorkItemState;
  readonly holderMustMatch: boolean;
  readonly role: LifecycleRole;
  readonly to: WorkItemState;
}

export const transitionTable: readonly TransitionRule[] = [
  {
    from: 'new',
    to: 'grooming_ready',
    role: 'navigator',
    holderMustMatch: false,
  },
  {
    from: 'new',
    to: 'design_ready',
    role: 'navigator',
    holderMustMatch: false,
  },
  { from: 'new', to: 'build_ready', role: 'navigator', holderMustMatch: false },
  { from: 'new', to: 'split', role: 'navigator', holderMustMatch: false },
  { from: 'new', to: 'cancelled', role: 'navigator', holderMustMatch: false },
  {
    from: 'grooming_ready',
    to: 'grooming',
    role: 'backend',
    holderMustMatch: false,
  },
  {
    from: 'grooming',
    to: 'design_ready',
    role: 'groomer',
    holderMustMatch: true,
  },
  {
    from: 'grooming',
    to: 'build_ready',
    role: 'groomer',
    holderMustMatch: true,
  },
  { from: 'grooming', to: 'split', role: 'groomer', holderMustMatch: true },
  { from: 'grooming', to: 'cancelled', role: 'groomer', holderMustMatch: true },
  {
    from: 'design_ready',
    to: 'designing',
    role: 'backend',
    holderMustMatch: false,
  },
  {
    from: 'designing',
    to: 'build_ready',
    role: 'designer',
    holderMustMatch: true,
  },
  {
    from: 'build_ready',
    to: 'building',
    role: 'backend',
    holderMustMatch: false,
  },
  {
    from: 'building',
    to: 'review_ready',
    role: 'builder',
    holderMustMatch: true,
  },
  {
    from: 'building',
    to: 'design_ready',
    role: 'builder',
    holderMustMatch: true,
  },
  {
    from: 'review_ready',
    to: 'reviewing',
    role: 'backend',
    holderMustMatch: false,
  },
  { from: 'reviewing', to: 'merging', role: 'reviewer', holderMustMatch: true },
  {
    from: 'reviewing',
    to: 'build_ready',
    role: 'reviewer',
    holderMustMatch: true,
  },
  {
    from: 'merging',
    to: 'verify_ready',
    role: 'backend',
    holderMustMatch: false,
  },
  { from: 'merging', to: 'done', role: 'backend', holderMustMatch: false },
  {
    from: 'merging',
    to: 'build_ready',
    role: 'backend',
    holderMustMatch: false,
  },
  { from: 'verifying', to: 'done', role: 'verifier', holderMustMatch: true },
  {
    from: 'verifying',
    to: 'build_ready',
    role: 'verifier',
    holderMustMatch: true,
  },
  {
    from: 'verifying',
    to: 'design_ready',
    role: 'verifier',
    holderMustMatch: true,
  },
  {
    from: 'done',
    to: 'build_ready',
    role: 'navigator',
    holderMustMatch: false,
  },
  {
    from: 'done',
    to: 'design_ready',
    role: 'navigator',
    holderMustMatch: false,
  },
];

const workingStates = new Set<WorkItemState>([
  'grooming',
  'designing',
  'building',
  'reviewing',
  'verifying',
]);

const stageForState: Partial<
  Record<WorkItemState, keyof LifecycleContext['stages']>
> = {
  design_ready: 'design',
  designing: 'design',
  grooming: 'grooming',
  grooming_ready: 'grooming',
  verify_ready: 'verify',
  verifying: 'verify',
};

const queueForWorkingState: Partial<Record<WorkItemState, WorkItemState>> = {
  building: 'build_ready',
  designing: 'design_ready',
  grooming: 'grooming_ready',
  reviewing: 'review_ready',
  verifying: 'verify_ready',
};

export function createWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  const state = overrides.state ?? 'new';
  const priority =
    overrides.priority ??
    (state === 'new' || state === 'cancelled' ? null : 'P1');

  return {
    attempts: 0,
    holderRunId: null,
    priority,
    rounds: 0,
    state,
    waitingKind: null,
    waitingReason: null,
    returnState: null,
    ...overrides,
  };
}

export function transition(
  item: WorkItem,
  request: TransitionRequest,
  context: LifecycleContext,
): TransitionResult {
  const unsupported = unsupportedState(request.to, context);
  if (unsupported !== undefined) {
    return refusal(unsupported);
  }

  const disabledStage = stageForState[request.to];
  if (disabledStage !== undefined && !context.stages[disabledStage]) {
    return refusal(`The ${disabledStage} stage is disabled for this project.`);
  }

  const rule = findRule(item, request);
  if (rule === undefined) {
    return refusalForMissingRule(item, request);
  }

  if (rule.holderMustMatch && item.holderRunId !== request.actor.runId) {
    return refusal('The actor does not hold this work item.');
  }

  if (
    item.state === 'new' &&
    request.to !== 'cancelled' &&
    request.priority === undefined
  ) {
    return refusal(
      'A navigator must set a priority when routing a new work item.',
    );
  }

  if (isWorkingState(request.to) && request.actor.runId === undefined) {
    return refusal('A working-state transition requires a run holder.');
  }

  if (request.to === 'waiting' && !isValidWaitingRequest(request)) {
    return refusal(
      'A waiting transition requires its kind, reason and return state.',
    );
  }

  const next = createWorkItem({
    ...item,
    attempts: nextAttempts(item, request),
    holderRunId: isWorkingState(request.to)
      ? (request.actor.runId ?? null)
      : null,
    priority: nextPriority(item, request),
    rounds: nextRounds(item, request),
    state: request.to,
    waitingKind: request.waiting?.kind ?? null,
    waitingReason: request.waiting?.reason ?? null,
    returnState: request.waiting?.returnState ?? null,
  });

  return {
    ok: true,
    item: next,
    effects: [
      { kind: 'history', reason: request.reason ?? null },
      ...(request.record === undefined
        ? []
        : [{ kind: 'record' as const, record: request.record }]),
    ],
  };
}

function findRule(
  item: WorkItem,
  request: TransitionRequest,
): TransitionRule | undefined {
  if (
    request.actor.role === 'navigator' &&
    request.to === 'cancelled' &&
    item.state !== 'cancelled'
  ) {
    return {
      from: item.state,
      to: request.to,
      role: 'navigator',
      holderMustMatch: false,
    };
  }

  if (
    request.actor.role === 'navigator' &&
    item.state === 'waiting' &&
    request.to === item.returnState
  ) {
    return {
      from: item.state,
      to: request.to,
      role: 'navigator',
      holderMustMatch: false,
    };
  }

  if (request.to === 'waiting' && canWait(item, request)) {
    return {
      from: item.state,
      to: request.to,
      role: request.actor.role as LifecycleRole,
      holderMustMatch: isWorkingState(item.state),
    };
  }

  const runEndedTarget = queueForWorkingState[item.state];
  if (
    request.actor.role === 'backend' &&
    runEndedTarget === request.to &&
    request.reason !== undefined
  ) {
    return {
      from: item.state,
      to: request.to,
      role: 'backend',
      holderMustMatch: false,
    };
  }

  return transitionTable.find(
    (candidate) =>
      candidate.from === item.state &&
      candidate.to === request.to &&
      candidate.role === request.actor.role,
  );
}

function canWait(item: WorkItem, request: TransitionRequest): boolean {
  if (item.state === 'done' || item.state === 'cancelled') {
    return false;
  }

  return (
    request.actor.role === 'backend' ||
    (isWorkingState(item.state) && request.actor.runId === item.holderRunId)
  );
}

function refusalForMissingRule(
  item: WorkItem,
  request: TransitionRequest,
): TransitionResult {
  if (
    request.to === 'review_ready' &&
    item.state === 'building' &&
    request.actor.role !== 'builder'
  ) {
    return refusal(
      'Only a builder holding the item can move it to review_ready.',
    );
  }

  return refusal(
    `${request.actor.role} cannot move a work item from ${item.state} to ${request.to}.`,
  );
}

function unsupportedState(
  state: WorkItemState,
  context: LifecycleContext,
): string | undefined {
  if (state === 'split' && !context.supportsSplitting) {
    return 'Splitting work items is unavailable in the MVP.';
  }

  if (state === 'verify_ready' || state === 'verifying') {
    return 'Verification is unavailable in the MVP.';
  }

  return undefined;
}

function isWorkingState(state: WorkItemState): boolean {
  return workingStates.has(state);
}

function isValidWaitingRequest(request: TransitionRequest): boolean {
  return (
    request.waiting !== undefined &&
    request.waiting.reason.length > 0 &&
    request.waiting.returnState !== 'waiting'
  );
}

function nextAttempts(item: WorkItem, request: TransitionRequest): number {
  return request.actor.role === 'backend' &&
    queueForWorkingState[item.state] === request.to
    ? item.attempts + 1
    : item.attempts;
}

function nextPriority(
  item: WorkItem,
  request: TransitionRequest,
): Priority | null {
  if (item.state === 'new' && request.to !== 'cancelled') {
    return request.priority ?? null;
  }

  if (
    item.state === 'verifying' &&
    (request.to === 'build_ready' || request.to === 'design_ready')
  ) {
    return 'P0';
  }

  return item.priority;
}

function nextRounds(item: WorkItem, request: TransitionRequest): number {
  if (
    request.to === 'build_ready' &&
    (item.state === 'reviewing' || item.state === 'merging')
  ) {
    return item.rounds + 1;
  }

  return item.rounds;
}

function refusal(reason: string): TransitionResult {
  return { ok: false, reason };
}
