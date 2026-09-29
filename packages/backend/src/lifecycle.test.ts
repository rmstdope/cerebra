import { describe, expect, test } from 'vitest';

import {
  createWorkItem,
  recordHeadings,
  recordProblem,
  runEndedRequest,
  transition,
  type LifecycleContext,
  type TransitionRequest,
  type WorkItemState,
} from './lifecycle.js';

const workingStates = new Set<WorkItemState>([
  'grooming',
  'designing',
  'building',
  'reviewing',
  'verifying',
]);

const context: LifecycleContext = {
  stages: { design: true, grooming: true, verify: false },
  maxRounds: 3,
  supportsSplitting: false,
};

function markdown(headings: readonly string[]): string {
  return headings.map((heading) => `## ${heading}\n\nNone.\n`).join('\n');
}

const outcome = { kind: 'outcome', markdown: markdown(recordHeadings.outcome) };
const design = { kind: 'design', markdown: markdown(recordHeadings.design) };
const pullRequest = {
  kind: 'pull_request',
  url: 'https://github.com/acme/website/pull/12',
  branch: 'web-12-export',
  head: '0123456789abcdef0123456789abcdef01234567',
};
const delivered = { checks: 'passed', planRecorded: true } as const;
const revision = '89abcdef0123456789abcdef0123456789abcdef';
const approved = {
  kind: 'review',
  verdict: 'approved',
  revision,
  findings: [],
};
const changesRequested = {
  kind: 'review',
  verdict: 'changes_requested',
  revision,
  findings: [
    {
      severity: 'blocking',
      file: 'src/export.ts',
      line: 4,
      problem: 'The header row is missing.',
    },
  ],
};

/** What each agent transition must carry (spec §4.4, §4.11); other rules take a generic record. */
function evidenceFor(
  from: WorkItemState,
  to: WorkItemState,
): Pick<TransitionRequest, 'reason' | 'record'> {
  const key = `${from}->${to}`;
  switch (key) {
    case 'grooming->design_ready':
    case 'grooming->build_ready':
      return { record: outcome };
    case 'designing->build_ready':
      return { record: design };
    case 'building->review_ready':
      return { record: pullRequest };
    case 'reviewing->merging':
      return { record: approved };
    case 'reviewing->build_ready':
      return { record: changesRequested };
    case 'grooming->cancelled':
    case 'building->design_ready':
      return { reason: 'The navigator decided otherwise.' };
    default:
      return { record: { kind: 'test' } };
  }
}

describe('lifecycle transitions', () => {
  test.each([
    ['new', 'grooming_ready', 'navigator'],
    ['new', 'design_ready', 'navigator'],
    ['new', 'build_ready', 'navigator'],
    ['new', 'cancelled', 'navigator'],
    ['grooming_ready', 'grooming', 'backend'],
    ['grooming', 'design_ready', 'groomer'],
    ['grooming', 'build_ready', 'groomer'],
    ['grooming', 'cancelled', 'groomer'],
    ['design_ready', 'designing', 'backend'],
    ['designing', 'build_ready', 'designer'],
    ['build_ready', 'building', 'backend'],
    ['building', 'review_ready', 'builder'],
    ['building', 'design_ready', 'builder'],
    ['review_ready', 'reviewing', 'backend'],
    ['reviewing', 'merging', 'reviewer'],
    ['reviewing', 'build_ready', 'reviewer'],
    ['merging', 'done', 'backend'],
    ['done', 'build_ready', 'navigator'],
    ['done', 'design_ready', 'navigator'],
  ] satisfies ReadonlyArray<readonly [WorkItemState, WorkItemState, string]>)(
    '%s -> %s is allowed for %s',
    (from, to, role) => {
      const result = transition(
        createWorkItem({
          state: from,
          holderRunId: workingStates.has(from) ? 'run-1' : null,
          ...(from === 'building' ? { build: delivered } : {}),
        }),
        {
          actor: {
            role,
            runId:
              workingStates.has(from) || workingStates.has(to)
                ? 'run-1'
                : undefined,
          },
          priority: from === 'new' ? 'P1' : undefined,
          to,
          ...evidenceFor(from, to),
        },
        context,
      );

      expect(result).toMatchObject({ ok: true, item: { state: to } });
    },
  );

  test('rejects a transition an actor is not allowed to make', () => {
    const result = transition(
      createWorkItem({ state: 'building', holderRunId: 'run-1' }),
      {
        actor: { role: 'designer', runId: 'run-1' },
        to: 'review_ready',
        record: { kind: 'pull_request' },
      },
      context,
    );

    expect(result).toEqual({
      ok: false,
      reason: 'Only a builder holding the item can move it to review_ready.',
    });
  });

  test('rejects a transition by a run that does not hold the item', () => {
    const result = transition(
      createWorkItem({ state: 'building', holderRunId: 'run-1' }),
      {
        actor: { role: 'builder', runId: 'run-2' },
        to: 'review_ready',
        record: { kind: 'pull_request' },
      },
      context,
    );

    expect(result).toEqual({
      ok: false,
      reason: 'The actor does not hold this work item.',
    });
  });

  test('requires a priority to route a new item', () => {
    const result = transition(
      createWorkItem({ state: 'new' }),
      {
        actor: { role: 'navigator' },
        to: 'build_ready',
        record: { kind: 'triage' },
      },
      context,
    );

    expect(result).toEqual({
      ok: false,
      reason: 'A navigator must set a priority when routing a new work item.',
    });
  });

  test('clears the holder when a working item returns to a queue', () => {
    const result = transition(
      createWorkItem({
        priority: 'P1',
        state: 'building',
        holderRunId: 'run-1',
      }),
      {
        actor: { role: 'builder', runId: 'run-1' },
        to: 'design_ready',
        reason: 'The agreed experience cannot be built as written.',
      },
      context,
    );

    expect(result).toMatchObject({
      ok: true,
      item: { holderRunId: null, state: 'design_ready' },
    });
  });

  test('returns a stopped run to its queue and increments attempts', () => {
    const result = transition(
      createWorkItem({
        attempts: 1,
        priority: 'P1',
        state: 'building',
        holderRunId: 'run-1',
      }),
      {
        actor: { role: 'backend' },
        reason: 'The run ended unexpectedly.',
        to: 'build_ready',
      },
      context,
    );

    expect(result).toMatchObject({
      ok: true,
      item: { attempts: 2, holderRunId: null, state: 'build_ready' },
    });
  });

  test('moves a held item to a navigator wait with complete metadata', () => {
    const result = transition(
      createWorkItem({
        priority: 'P1',
        state: 'building',
        holderRunId: 'run-1',
      }),
      {
        actor: { role: 'builder', runId: 'run-1' },
        to: 'waiting',
        waiting: {
          kind: 'question',
          reason: 'The requested implementation has an unresolved scope.',
          returnState: 'build_ready',
        },
      },
      context,
    );

    expect(result).toMatchObject({
      ok: true,
      item: {
        holderRunId: null,
        returnState: 'build_ready',
        state: 'waiting',
        waitingKind: 'question',
      },
    });
  });

  test('returns a waiting item to its recorded state only through the navigator', () => {
    const item = createWorkItem({
      priority: 'P1',
      state: 'waiting',
      waitingKind: 'question',
      waitingReason: 'A decision is needed.',
      returnState: 'build_ready',
    });

    expect(
      transition(
        item,
        { actor: { role: 'builder' }, to: 'build_ready' },
        context,
      ),
    ).toEqual({
      ok: false,
      reason: 'builder cannot move a work item from waiting to build_ready.',
    });
    expect(
      transition(
        item,
        { actor: { role: 'navigator' }, to: 'build_ready' },
        context,
      ),
    ).toMatchObject({
      ok: true,
      item: {
        returnState: null,
        state: 'build_ready',
        waitingKind: null,
        waitingReason: null,
      },
    });
  });

  test.each([
    'grooming_ready',
    'design_ready',
    'build_ready',
    'review_ready',
    'merging',
    'done',
    'cancelled',
  ] satisfies readonly WorkItemState[])(
    'lets the navigator move a waiting item to %s, which it picks',
    (to) => {
      const result = transition(
        createWorkItem({
          priority: 'P2',
          returnState: 'merging',
          state: 'waiting',
          waitingKind: 'code_review',
          waitingReason: 'Ready for your review.',
        }),
        { actor: { role: 'navigator' }, reason: 'Changed course.', to },
        context,
      );

      expect(result).toMatchObject({
        ok: true,
        item: {
          priority: 'P2',
          returnState: null,
          state: to,
          waitingKind: null,
          waitingReason: null,
        },
      });
    },
  );

  test('clears the priority when the navigator returns a waiting item to new', () => {
    expect(
      transition(
        createWorkItem({
          priority: 'P1',
          returnState: 'build_ready',
          state: 'waiting',
          waitingKind: 'escalation',
          waitingReason: 'Attempts ran out.',
        }),
        { actor: { role: 'navigator' }, reason: 'Triage again.', to: 'new' },
        context,
      ),
    ).toMatchObject({ ok: true, item: { priority: null, state: 'new' } });
  });

  test.each(['building', 'grooming', 'waiting'] satisfies WorkItemState[])(
    'refuses a navigator move from waiting to %s',
    (to) => {
      const result = transition(
        createWorkItem({
          priority: 'P1',
          returnState: 'build_ready',
          state: 'waiting',
          waitingKind: 'escalation',
          waitingReason: 'Attempts ran out.',
        }),
        { actor: { role: 'navigator' }, to },
        context,
      );

      expect(result.ok).toBe(false);
    },
  );

  test('refuses a navigator move from waiting to a stage that is off', () => {
    expect(
      transition(
        createWorkItem({
          priority: 'P1',
          returnState: 'build_ready',
          state: 'waiting',
          waitingKind: 'escalation',
          waitingReason: 'Attempts ran out.',
        }),
        { actor: { role: 'navigator' }, to: 'design_ready' },
        { ...context, stages: { ...context.stages, design: false } },
      ),
    ).toEqual({
      ok: false,
      reason: 'The design stage is disabled for this project.',
    });
  });

  test('refuses a wait whose return state bypasses the lifecycle', () => {
    const result = transition(
      createWorkItem({
        priority: 'P1',
        state: 'building',
        holderRunId: 'run-1',
      }),
      {
        actor: { role: 'builder', runId: 'run-1' },
        to: 'waiting',
        waiting: {
          kind: 'question',
          reason: 'A decision is needed.',
          returnState: 'merging',
        },
      },
      context,
    );

    expect(result).toEqual({
      ok: false,
      reason: 'A waiting item must return to its originating queue state.',
    });
  });

  test('refuses an attempt to wait an already waiting item', () => {
    const result = transition(
      createWorkItem({
        priority: 'P1',
        returnState: 'build_ready',
        state: 'waiting',
        waitingKind: 'question',
        waitingReason: 'A decision is needed.',
      }),
      {
        actor: { role: 'backend' },
        to: 'waiting',
        waiting: {
          kind: 'question',
          reason: 'A second decision is needed.',
          returnState: 'waiting',
        },
      },
      context,
    );

    expect(result).toEqual({
      ok: false,
      reason: 'A waiting item must return to its originating queue state.',
    });
  });

  test('allows the navigator to cancel any non-terminal work item', () => {
    expect(
      transition(
        createWorkItem({
          priority: 'P1',
          state: 'review_ready',
        }),
        { actor: { role: 'navigator' }, to: 'cancelled' },
        context,
      ),
    ).toMatchObject({ ok: true, item: { state: 'cancelled' } });
  });

  test('rejects disabled stages and unsupported MVP states', () => {
    const noDesignContext: LifecycleContext = {
      ...context,
      stages: { ...context.stages, design: false },
    };

    expect(
      transition(
        createWorkItem({ state: 'new' }),
        {
          actor: { role: 'navigator' },
          priority: 'P1',
          to: 'design_ready',
          record: { kind: 'triage' },
        },
        noDesignContext,
      ),
    ).toEqual({
      ok: false,
      reason: 'The design stage is disabled for this project.',
    });

    expect(
      transition(
        createWorkItem({ state: 'new' }),
        {
          actor: { role: 'navigator' },
          priority: 'P1',
          to: 'split',
          record: { kind: 'triage' },
        },
        context,
      ),
    ).toEqual({
      ok: false,
      reason: 'Splitting work items is unavailable in the MVP.',
    });

    expect(
      transition(
        createWorkItem({ priority: 'P1', state: 'merging' }),
        {
          actor: { role: 'backend' },
          to: 'verify_ready',
          record: { kind: 'merge' },
        },
        { ...context, stages: { ...context.stages, verify: true } },
      ),
    ).toEqual({
      ok: false,
      reason: 'Verification is unavailable in the MVP.',
    });
  });
});

describe('the record an agent transition requires', () => {
  function held(state: WorkItemState) {
    return createWorkItem({ holderRunId: 'run-1', priority: 'P1', state });
  }
  function by(role: string, to: WorkItemState, extra: object = {}) {
    return { actor: { role, runId: 'run-1' }, to, ...extra };
  }

  test.each([
    ['grooming', 'design_ready', 'groomer', 'an outcome record'],
    ['grooming', 'build_ready', 'groomer', 'an outcome record'],
    ['designing', 'build_ready', 'designer', 'a design record'],
    ['building', 'review_ready', 'builder', 'a pull_request record'],
    ['reviewing', 'merging', 'reviewer', 'a review record'],
    ['reviewing', 'build_ready', 'reviewer', 'a review record'],
  ] satisfies ReadonlyArray<
    readonly [WorkItemState, WorkItemState, string, string]
  >)('refuses %s -> %s by a %s without %s', (from, to, role, needed) => {
    for (const record of [undefined, { kind: 'test' }]) {
      expect(
        transition(
          held(from),
          by(role, to, record === undefined ? {} : { record }),
          context,
        ),
      ).toEqual({
        ok: false,
        reason: `Moving a work item from ${from} to ${to} needs ${needed}.`,
      });
    }
  });

  test.each([
    ['grooming', 'split', 'groomer', {}],
    ['grooming', 'cancelled', 'groomer', { reason: 'Duplicate.' }],
    ['building', 'design_ready', 'builder', { reason: 'Needs a design.' }],
  ] satisfies ReadonlyArray<
    readonly [WorkItemState, WorkItemState, string, object]
  >)(
    'refuses a record on %s -> %s by a %s, which needs none',
    (from, to, role, extra) => {
      expect(
        transition(
          held(from),
          by(role, to, { ...extra, record: { kind: 'claim', role: 'x' } }),
          { ...context, supportsSplitting: true },
        ),
      ).toEqual({
        ok: false,
        reason: `Moving a work item from ${from} to ${to} takes no record.`,
      });
    },
  );

  test('refuses a record on an agent’s wait for the navigator', () => {
    expect(
      transition(
        held('grooming'),
        by('groomer', 'waiting', {
          record: { kind: 'triage' },
          waiting: {
            kind: 'question',
            reason: 'Which?',
            returnState: 'grooming_ready',
          },
        }),
        context,
      ),
    ).toEqual({
      ok: false,
      reason: 'Moving a work item from grooming to waiting takes no record.',
    });
  });

  test.each([
    ['grooming', 'cancelled', 'groomer'],
    ['building', 'design_ready', 'builder'],
  ] satisfies ReadonlyArray<readonly [WorkItemState, WorkItemState, string]>)(
    'refuses %s -> %s by a %s without a reason',
    (from, to, role) => {
      for (const reason of [undefined, '   ']) {
        expect(
          transition(
            held(from),
            by(role, to, reason === undefined ? {} : { reason }),
            context,
          ),
        ).toEqual({
          ok: false,
          reason: `Moving a work item from ${from} to ${to} needs a reason.`,
        });
      }
    },
  );

  test('names a missing heading of an outcome record', () => {
    const withoutRoute = markdown(
      recordHeadings.outcome.filter((heading) => heading !== 'Route'),
    );

    expect(
      transition(
        held('grooming'),
        by('groomer', 'design_ready', {
          record: { kind: 'outcome', markdown: withoutRoute },
        }),
        context,
      ),
    ).toEqual({
      ok: false,
      reason: 'The outcome record is missing its "## Route" section.',
    });
  });

  test('refuses a heading left empty or written twice', () => {
    const empty = outcome.markdown.replace(
      '## Problem\n\nNone.\n',
      '## Problem\n\n',
    );
    const twice = `${outcome.markdown}\n## Problem\n\nAgain.\n`;

    expect(
      transition(
        held('grooming'),
        by('groomer', 'build_ready', {
          record: { kind: 'outcome', markdown: empty },
        }),
        context,
      ),
    ).toEqual({
      ok: false,
      reason:
        'The outcome record\'s "## Problem" section is empty; write None. and why if it does not apply.',
    });
    expect(
      transition(
        held('grooming'),
        by('groomer', 'build_ready', {
          record: { kind: 'outcome', markdown: twice },
        }),
        context,
      ),
    ).toEqual({
      ok: false,
      reason: 'The outcome record has more than one "## Problem" section.',
    });
  });

  test('names a missing heading of a design record', () => {
    expect(
      transition(
        held('designing'),
        by('designer', 'build_ready', {
          record: { kind: 'design', markdown: markdown(['The states']) },
        }),
        context,
      ),
    ).toEqual({
      ok: false,
      reason:
        'The design record is missing its "## The agreed experience" section.',
    });
  });

  test.each([
    [{ url: 'http://github.com/acme/website/pull/12' }, 'url'],
    [{ url: 'https://example.com/acme/website/pull/12' }, 'url'],
    [{ branch: ' ' }, 'branch'],
    [{ head: 'main' }, 'head'],
  ])('refuses a pull request record with a bad %o', (change, field) => {
    expect(
      transition(
        held('building'),
        by('builder', 'review_ready', {
          record: { ...pullRequest, ...change },
        }),
        context,
      ),
    ).toEqual({
      ok: false,
      reason: `The pull_request record has no valid ${field}.`,
    });
  });

  test.each([
    [
      { checks: 'passed', planRecorded: false },
      'Record the plan with submit_plan before handing the item to review.',
    ],
    [
      { checks: null, planRecorded: true },
      'Report passing checks with report_checks before handing the item to review.',
    ],
    [
      { checks: 'failed', planRecorded: true },
      'The latest checks failed; correct them and report passing checks with report_checks before handing the item to review.',
    ],
    [
      undefined,
      'Record the plan with submit_plan before handing the item to review.',
    ],
  ] as const)(
    'refuses building -> review_ready with build evidence %o',
    (build, reason) => {
      expect(
        transition(
          createWorkItem({
            build,
            holderRunId: 'run-1',
            priority: 'P1',
            state: 'building',
          }),
          by('builder', 'review_ready', { record: pullRequest }),
          context,
        ),
      ).toEqual({ ok: false, reason });
    },
  );

  test('accepts a plan record under its exact headings', () => {
    expect(recordHeadings.plan).toEqual([
      'Context',
      'Files to change, and what to reuse',
      'Increments',
      'The test plan',
      'User-facing decisions',
      'Out of scope',
      'Validation',
      'Known traps',
    ]);
    expect(recordProblem('plan', markdown(recordHeadings.plan))).toBe(
      undefined,
    );
    expect(recordProblem('plan', markdown(['Context']))).toBe(
      'The plan record is missing its "## Files to change, and what to reuse" section.',
    );
  });

  test('refuses an approval that carries a blocking finding', () => {
    expect(
      transition(
        held('reviewing'),
        by('reviewer', 'merging', {
          record: { ...changesRequested, verdict: 'approved' },
        }),
        context,
      ),
    ).toEqual({
      ok: false,
      reason: 'An approved review cannot carry a blocking finding.',
    });
  });

  test('refuses a verdict that does not match the move', () => {
    expect(
      transition(
        held('reviewing'),
        by('reviewer', 'build_ready', { record: approved }),
        context,
      ),
    ).toEqual({
      ok: false,
      reason:
        'Moving a work item from reviewing to build_ready needs a review verdict of changes_requested.',
    });
  });

  test('refuses changes requested without a blocking finding', () => {
    expect(
      transition(
        held('reviewing'),
        by('reviewer', 'build_ready', {
          record: { ...changesRequested, findings: [] },
        }),
        context,
      ),
    ).toEqual({
      ok: false,
      reason: 'Requesting changes needs at least one blocking finding.',
    });
  });

  test('refuses a finding without its file or problem', () => {
    expect(
      transition(
        held('reviewing'),
        by('reviewer', 'build_ready', {
          record: {
            ...changesRequested,
            findings: [{ severity: 'blocking', file: '', problem: 'x' }],
          },
        }),
        context,
      ),
    ).toEqual({
      ok: false,
      reason:
        'Every review finding needs a severity (blocking or advisory), a file and a problem.',
    });
  });

  test('keeps the record it accepted as the transition’s effect', () => {
    expect(
      transition(
        held('grooming'),
        by('groomer', 'design_ready', { record: outcome }),
        context,
      ),
    ).toMatchObject({
      ok: true,
      effects: [{ kind: 'history' }, { kind: 'record', record: outcome }],
    });
  });
});

describe('when the holding run ends', () => {
  const held = createWorkItem({
    attempts: 0,
    holderRunId: 'run-1',
    priority: 'P1',
    state: 'building',
  });

  test('the item goes back to its queue with one more attempt', () => {
    const request = runEndedRequest(held, {
      maxAttempts: 3,
      reason: 'The run failed.',
    });

    expect(transition(held, request, context)).toMatchObject({
      ok: true,
      item: {
        attempts: 1,
        holderRunId: null,
        state: 'build_ready',
        waitingKind: null,
      },
    });
  });

  test('the attempt that reaches max_attempts escalates to the navigator', () => {
    const item = { ...held, attempts: 2 };
    const request = runEndedRequest(item, {
      maxAttempts: 3,
      reason: 'The run failed.',
    });

    expect(transition(item, request, context)).toMatchObject({
      ok: true,
      item: {
        attempts: 3,
        holderRunId: null,
        returnState: 'build_ready',
        state: 'waiting',
        waitingKind: 'escalation',
        waitingReason: 'The run failed.',
      },
    });
  });

  test('an escalation keeps the item’s attempts once it is past the limit', () => {
    const item = { ...held, attempts: 5, state: 'reviewing' as const };
    const request = runEndedRequest(item, {
      maxAttempts: 3,
      reason: 'Stopped by the navigator.',
    });

    expect(transition(item, request, context)).toMatchObject({
      ok: true,
      item: { attempts: 6, returnState: 'review_ready', state: 'waiting' },
    });
  });
});

describe('review rounds and escalation (spec §4.5)', () => {
  const reviewing = (rounds: number) =>
    createWorkItem({
      holderRunId: 'run-1',
      rounds,
      state: 'reviewing',
    });
  const requestChanges: TransitionRequest = {
    actor: { role: 'reviewer', runId: 'run-1' },
    record: changesRequested,
    to: 'build_ready',
  };

  test('changes requested below max_rounds go back to the builder with one more round', () => {
    expect(transition(reviewing(1), requestChanges, context)).toMatchObject({
      ok: true,
      item: { rounds: 2, state: 'build_ready', waitingKind: null },
    });
  });

  test('changes requested that reach max_rounds wait for the navigator instead', () => {
    const result = transition(reviewing(2), requestChanges, context);

    expect(result).toMatchObject({
      ok: true,
      item: {
        rounds: 3,
        returnState: 'build_ready',
        state: 'waiting',
        waitingKind: 'escalation',
        waitingReason: "Can't merge: too many rounds",
      },
      effects: [
        { kind: 'history' },
        { kind: 'record', record: changesRequested },
        {
          kind: 'record',
          record: { kind: 'blocked', reason: 'too_many_rounds', count: 3 },
        },
      ],
    });
  });

  test('rounds start again once the item leaves waiting', () => {
    const waiting = createWorkItem({
      rounds: 3,
      returnState: 'build_ready',
      state: 'waiting',
      waitingKind: 'escalation',
      waitingReason: "Can't merge: too many rounds",
    });

    expect(
      transition(
        waiting,
        { actor: { role: 'navigator' }, to: 'build_ready' },
        context,
      ),
    ).toMatchObject({ ok: true, item: { rounds: 0, state: 'build_ready' } });
  });

  test('an approval must name the revision it reviewed', () => {
    expect(
      transition(
        reviewing(0),
        {
          actor: { role: 'reviewer', runId: 'run-1' },
          record: { kind: 'review', verdict: 'approved', findings: [] },
          to: 'merging',
        },
        context,
      ),
    ).toEqual({
      ok: false,
      reason: 'The review record has no valid revision.',
    });
  });

  test('a review link must be a GitHub address', () => {
    expect(
      transition(
        reviewing(0),
        {
          actor: { role: 'reviewer', runId: 'run-1' },
          record: { ...approved, url: 'https://example.com/review' },
          to: 'merging',
        },
        context,
      ),
    ).toEqual({ ok: false, reason: 'The review record has no valid url.' });
    expect(
      transition(
        reviewing(0),
        {
          actor: { role: 'reviewer', runId: 'run-1' },
          record: {
            ...approved,
            url: 'https://github.com/acme/website/pull/12#pullrequestreview-7',
          },
          to: 'merging',
        },
        context,
      ),
    ).toMatchObject({ ok: true });
  });
});

describe('attempts per stage (spec §4.5)', () => {
  test('attempts start again when the item moves to a different stage', () => {
    const building = createWorkItem({
      attempts: 2,
      build: delivered,
      holderRunId: 'run-1',
      state: 'building',
    });

    expect(
      transition(
        building,
        {
          actor: { role: 'builder', runId: 'run-1' },
          record: pullRequest,
          to: 'review_ready',
        },
        context,
      ),
    ).toMatchObject({ ok: true, item: { attempts: 0 } });
  });

  test('a claim in the same stage keeps the attempts', () => {
    expect(
      transition(
        createWorkItem({ attempts: 2, state: 'build_ready' }),
        { actor: { role: 'backend', runId: 'run-2' }, to: 'building' },
        context,
      ),
    ).toMatchObject({ ok: true, item: { attempts: 2 } });
  });

  test('an answered escalation starts the attempts again', () => {
    expect(
      transition(
        createWorkItem({
          attempts: 3,
          returnState: 'build_ready',
          state: 'waiting',
          waitingKind: 'escalation',
          waitingReason: 'Stopped: too many attempts',
        }),
        { actor: { role: 'navigator' }, to: 'build_ready' },
        context,
      ),
    ).toMatchObject({ ok: true, item: { attempts: 0 } });
  });
});

describe('a merge the backend cannot make (spec §4.4)', () => {
  test('the backend escalates a merging item and returns it to merging', () => {
    expect(
      transition(
        createWorkItem({ state: 'merging' }),
        {
          actor: { role: 'backend' },
          reason: 'A required check failed.',
          to: 'waiting',
          waiting: {
            kind: 'escalation',
            reason: "Can't merge: a required check failed",
            returnState: 'merging',
          },
        },
        context,
      ),
    ).toMatchObject({
      ok: true,
      item: { returnState: 'merging', state: 'waiting' },
    });
  });

  test('the backend can no longer send a merging item straight back to the builder', () => {
    expect(
      transition(
        createWorkItem({ state: 'merging' }),
        { actor: { role: 'backend' }, to: 'build_ready' },
        context,
      ),
    ).toMatchObject({ ok: false });
  });
});
