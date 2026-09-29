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
  /**
   * What the holding run has recorded while building (spec §4.4, §4.11): whether it recorded a
   * plan, and the result of the last checks it reported. Absent means neither.
   */
  readonly build?: BuildEvidence;
}

export interface BuildEvidence {
  readonly checks: 'failed' | 'passed' | null;
  readonly planRecorded: boolean;
}

export interface LifecycleContext {
  readonly stages: {
    readonly design: boolean;
    readonly grooming: boolean;
    readonly verify: boolean;
  };
  /** The project's `max_rounds` (spec §4.5): the send-back that reaches it waits instead. */
  readonly maxRounds: number;
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

/** What an agent transition must carry before the engine accepts it (spec §4.4, §4.11). */
export type RequiredEvidence =
  | 'design'
  | 'outcome'
  | 'pull_request'
  | 'reason'
  | 'review_approved'
  | 'review_changes';

interface TransitionRule {
  readonly from: WorkItemState;
  readonly holderMustMatch: boolean;
  readonly requires?: RequiredEvidence;
  readonly role: LifecycleRole;
  readonly to: WorkItemState;
}

/** The `##` headings of each Markdown record, spelled exactly (spec §4.11). */
export const recordHeadings = {
  outcome: [
    'Problem',
    'Who benefits',
    'Outcome',
    'Out of scope',
    'How we will know',
    'Route',
  ],
  design: [
    'The agreed experience',
    'The states',
    'The words, exactly',
    'What was considered and rejected',
    'The mockup',
  ],
  plan: [
    'Context',
    'Files to change, and what to reuse',
    'Increments',
    'The test plan',
    'User-facing decisions',
    'Out of scope',
    'Validation',
    'Known traps',
  ],
} as const;

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
    requires: 'outcome',
  },
  {
    from: 'grooming',
    to: 'build_ready',
    role: 'groomer',
    holderMustMatch: true,
    requires: 'outcome',
  },
  { from: 'grooming', to: 'split', role: 'groomer', holderMustMatch: true },
  {
    from: 'grooming',
    to: 'cancelled',
    role: 'groomer',
    holderMustMatch: true,
    requires: 'reason',
  },
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
    requires: 'design',
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
    requires: 'pull_request',
  },
  {
    from: 'building',
    to: 'design_ready',
    role: 'builder',
    holderMustMatch: true,
    requires: 'reason',
  },
  {
    from: 'review_ready',
    to: 'reviewing',
    role: 'backend',
    holderMustMatch: false,
  },
  {
    from: 'reviewing',
    to: 'merging',
    role: 'reviewer',
    holderMustMatch: true,
    requires: 'review_approved',
  },
  {
    from: 'reviewing',
    to: 'build_ready',
    role: 'reviewer',
    holderMustMatch: true,
    requires: 'review_changes',
  },
  {
    from: 'merging',
    to: 'verify_ready',
    role: 'backend',
    holderMustMatch: false,
  },
  { from: 'merging', to: 'done', role: 'backend', holderMustMatch: false },
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

/** The queue a working state's item returns to, or `undefined` for a state no run works in. */
export function queueFor(state: WorkItemState): WorkItemState | undefined {
  return queueForWorkingState[state];
}

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

  if (rule.requires !== undefined) {
    const missing = missingEvidence(rule, rule.requires, request);
    if (missing !== undefined) {
      return refusal(missing);
    }
  }

  if (rule.from === 'building' && rule.to === 'review_ready') {
    const unbuilt = buildProblem(item.build);
    if (unbuilt !== undefined) {
      return refusal(unbuilt);
    }
  }

  // An agent's record is evidence for the move it asks for, never a record of the backend's kind.
  const agentMove = rule.role !== 'backend' && rule.role !== 'navigator';
  const takesRecord = rule.requires !== undefined && rule.requires !== 'reason';
  if (agentMove && !takesRecord && request.record !== undefined) {
    return refusal(
      `Moving a work item from ${item.state} to ${request.to} takes no record.`,
    );
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

  if (request.to === 'waiting' && !isValidWaitingRequest(item, request)) {
    return refusal(
      'A waiting item must return to its originating queue state.',
    );
  }

  const rounds = nextRounds(item, request);
  if (
    rule.from === 'reviewing' &&
    rule.to === 'build_ready' &&
    rounds >= context.maxRounds
  ) {
    return tooManyRounds(item, request, rounds);
  }

  const next = createWorkItem({
    ...item,
    attempts: nextAttempts(item, request),
    holderRunId: isWorkingState(request.to)
      ? (request.actor.runId ?? null)
      : null,
    priority: nextPriority(item, request),
    rounds,
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

/** The heading a person sees when changes requested reach `max_rounds` (spec §4.5). */
export const tooManyRoundsReason = "Can't merge: too many rounds";

/**
 * A send-back that reaches `max_rounds` waits for the navigator instead (spec §4.5), keeping the
 * review that requested it and recording why the item stopped.
 */
function tooManyRounds(
  item: WorkItem,
  request: TransitionRequest,
  rounds: number,
): TransitionResult {
  return {
    ok: true,
    item: createWorkItem({
      ...item,
      attempts: 0,
      holderRunId: null,
      rounds,
      state: 'waiting',
      waitingKind: 'escalation',
      waitingReason: tooManyRoundsReason,
      returnState: 'build_ready',
    }),
    effects: [
      { kind: 'history', reason: request.reason ?? tooManyRoundsReason },
      ...(request.record === undefined
        ? []
        : [{ kind: 'record' as const, record: request.record }]),
      {
        kind: 'record',
        record: { kind: 'blocked', reason: 'too_many_rounds', count: rounds },
      },
    ],
  };
}

/**
 * What the backend asks for when the run holding `item` ends without moving it (spec §4.5): back
 * to its queue with one more attempt, or, when that attempt reaches `maxAttempts`, to the
 * navigator as an escalation that returns to the same queue.
 */
export function runEndedRequest(
  item: WorkItem,
  options: { readonly maxAttempts: number; readonly reason: string },
): TransitionRequest {
  const queue = queueForWorkingState[item.state];
  if (queue === undefined) {
    throw new Error(`A ${item.state} item is not held by a run.`);
  }
  const actor = {
    role: 'backend',
    ...(item.holderRunId === null ? {} : { runId: item.holderRunId }),
  };
  if (item.attempts + 1 >= options.maxAttempts) {
    return {
      actor,
      reason: options.reason,
      to: 'waiting',
      waiting: {
        kind: 'escalation',
        reason: options.reason,
        returnState: queue,
      },
    };
  }
  return { actor, reason: options.reason, to: queue };
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

  // Spec §4.4: the navigator answers a wait by returning it, or by picking
  // any state a navigator can put an item in (never one that needs a run or
  // another wait).
  if (
    request.actor.role === 'navigator' &&
    item.state === 'waiting' &&
    request.to !== 'waiting' &&
    !isWorkingState(request.to)
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

const evidenceNames: Record<RequiredEvidence, string> = {
  design: 'a design record',
  outcome: 'an outcome record',
  pull_request: 'a pull_request record',
  reason: 'a reason',
  review_approved: 'a review record',
  review_changes: 'a review record',
};

function missingEvidence(
  rule: TransitionRule,
  requires: RequiredEvidence,
  request: TransitionRequest,
): string | undefined {
  const needs = `Moving a work item from ${rule.from} to ${rule.to} needs`;
  if (requires === 'reason') {
    return (request.reason ?? '').trim() === ''
      ? `${needs} a reason.`
      : undefined;
  }
  const record = request.record;
  const kind = requires.startsWith('review') ? 'review' : requires;
  if (record?.kind !== kind) {
    return `${needs} ${evidenceNames[requires]}.`;
  }
  switch (requires) {
    case 'outcome':
    case 'design':
      return markdownProblem(requires, record.markdown);
    case 'pull_request':
      return pullRequestProblem(record);
    case 'review_approved':
    case 'review_changes':
      return reviewProblem(requires, record, needs);
  }
}

function buildProblem(build: BuildEvidence | undefined): string | undefined {
  const handOver = 'before handing the item to review.';
  if (build?.planRecorded !== true) {
    return `Record the plan with submit_plan ${handOver}`;
  }
  if (build.checks === null) {
    return `Report passing checks with report_checks ${handOver}`;
  }
  if (build.checks === 'failed') {
    return `The latest checks failed; correct them and report passing checks with report_checks ${handOver}`;
  }
  return undefined;
}

/** What is wrong with a Markdown record's headings (spec §4.11), or undefined when nothing is. */
export function recordProblem(
  kind: keyof typeof recordHeadings,
  markdown: unknown,
): string | undefined {
  return markdownProblem(kind, markdown);
}

function markdownProblem(
  kind: keyof typeof recordHeadings,
  markdown: unknown,
): string | undefined {
  const text = typeof markdown === 'string' ? markdown : '';
  const lines = text.split(/\r?\n/);
  const headingLines = lines
    .map((line, index) => ({ index, match: /^##\s+(.*?)\s*$/.exec(line) }))
    .filter((entry) => entry.match !== null)
    .map((entry) => ({ index: entry.index, title: entry.match?.[1] ?? '' }));
  for (const heading of recordHeadings[kind]) {
    const found = headingLines.filter((entry) => entry.title === heading);
    if (found.length === 0) {
      return `The ${kind} record is missing its "## ${heading}" section.`;
    }
    if (found.length > 1) {
      return `The ${kind} record has more than one "## ${heading}" section.`;
    }
    const start = found[0]?.index ?? 0;
    const next = headingLines.find((entry) => entry.index > start);
    const body = lines.slice(start + 1, next?.index ?? lines.length).join('');
    if (body.trim() === '') {
      return `The ${kind} record's "## ${heading}" section is empty; write None. and why if it does not apply.`;
    }
  }
  return undefined;
}

function pullRequestProblem(
  record: Readonly<Record<string, unknown>>,
): string | undefined {
  const invalid = (field: string) =>
    `The pull_request record has no valid ${field}.`;
  if (
    typeof record.url !== 'string' ||
    !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(record.url)
  ) {
    return invalid('url');
  }
  if (typeof record.branch !== 'string' || record.branch.trim() === '') {
    return invalid('branch');
  }
  if (
    typeof record.head !== 'string' ||
    !/^[0-9a-f]{7,64}$/i.test(record.head)
  ) {
    return invalid('head');
  }
  return undefined;
}

function reviewProblem(
  requires: 'review_approved' | 'review_changes',
  record: Readonly<Record<string, unknown>>,
  needs: string,
): string | undefined {
  const verdict =
    requires === 'review_approved' ? 'approved' : 'changes_requested';
  if (record.verdict !== verdict) {
    return `${needs} a review verdict of ${verdict}.`;
  }
  if (
    typeof record.revision !== 'string' ||
    !/^[0-9a-f]{7,64}$/i.test(record.revision)
  ) {
    return 'The review record has no valid revision.';
  }
  if (
    record.url !== undefined &&
    (typeof record.url !== 'string' ||
      !/^https:\/\/github\.com\/\S+$/.test(record.url))
  ) {
    return 'The review record has no valid url.';
  }
  const findings = record.findings;
  if (!Array.isArray(findings) || !findings.every(isFinding)) {
    return 'Every review finding needs a severity (blocking or advisory), a file and a problem.';
  }
  const blocking = findings.some((finding) => finding.severity === 'blocking');
  if (verdict === 'approved' && blocking) {
    return 'An approved review cannot carry a blocking finding.';
  }
  if (verdict === 'changes_requested' && !blocking) {
    return 'Requesting changes needs at least one blocking finding.';
  }
  return undefined;
}

function isFinding(
  value: unknown,
): value is { readonly severity: 'advisory' | 'blocking' } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const finding = value as Record<string, unknown>;
  return (
    (finding.severity === 'blocking' || finding.severity === 'advisory') &&
    typeof finding.file === 'string' &&
    finding.file.trim() !== '' &&
    typeof finding.problem === 'string' &&
    finding.problem.trim() !== '' &&
    (finding.line === undefined ||
      (Number.isInteger(finding.line) && (finding.line as number) > 0))
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

function isValidWaitingRequest(
  item: WorkItem,
  request: TransitionRequest,
): boolean {
  return (
    request.waiting !== undefined &&
    request.waiting.reason.length > 0 &&
    request.waiting.returnState !== 'waiting' &&
    request.waiting.returnState ===
      (queueForWorkingState[item.state] ?? item.state)
  );
}

/** Which stage's attempts a state counts toward; `waiting` and the ends count toward none. */
const attemptStage: Partial<Record<WorkItemState, string>> = {
  build_ready: 'build',
  building: 'build',
  design_ready: 'design',
  designing: 'design',
  grooming: 'grooming',
  grooming_ready: 'grooming',
  merging: 'merge',
  review_ready: 'review',
  reviewing: 'review',
  verify_ready: 'verify',
  verifying: 'verify',
};

function nextAttempts(item: WorkItem, request: TransitionRequest): number {
  if (
    request.to !== 'waiting' &&
    attemptStage[item.state] !== attemptStage[request.to]
  ) {
    return 0;
  }
  const queue = queueForWorkingState[item.state];
  const runEnded =
    request.actor.role === 'backend' &&
    queue !== undefined &&
    (request.to === queue ||
      (request.to === 'waiting' && request.waiting?.kind === 'escalation'));
  return runEnded ? item.attempts + 1 : item.attempts;
}

function nextPriority(
  item: WorkItem,
  request: TransitionRequest,
): Priority | null {
  if (item.state === 'new' && request.to !== 'cancelled') {
    return request.priority ?? null;
  }

  if (request.to === 'new') {
    return null;
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
  if (item.state === 'waiting') {
    return 0;
  }
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
