import { describe, expect, test } from 'vitest';

import {
  createWorkItem,
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
          returnState: 'building',
        },
      },
      context,
    );

    expect(result).toMatchObject({
      ok: true,
      item: {
        holderRunId: null,
        returnState: 'building',
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
