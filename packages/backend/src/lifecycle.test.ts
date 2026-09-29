import { describe, expect, test } from 'vitest';

import {
  createWorkItem,
  runEndedRequest,
  transition,
  type LifecycleContext,
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
  supportsSplitting: false,
};

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
    ['merging', 'build_ready', 'backend'],
    ['done', 'build_ready', 'navigator'],
    ['done', 'design_ready', 'navigator'],
  ] satisfies ReadonlyArray<readonly [WorkItemState, WorkItemState, string]>)(
    '%s -> %s is allowed for %s',
    (from, to, role) => {
      const result = transition(
        createWorkItem({
          state: from,
          holderRunId: workingStates.has(from) ? 'run-1' : null,
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
          record: { kind: 'test' },
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
        record: { kind: 'experience_problem' },
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
