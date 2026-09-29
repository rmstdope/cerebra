import { describe, expect, test } from 'vitest';

import {
  planDispatch,
  type PlanAgent,
  type PlanItem,
  type PlanSnapshot,
  type PlanType,
} from './dispatch-plan.js';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 3, 12, minute));

function project(
  id: string,
  overrides: Partial<PlanSnapshot['projects'][number]> = {},
) {
  return { id, limit: 3, paused: false, running: 0, ...overrides };
}

function producer(
  projectId: string,
  overrides: Partial<PlanType> = {},
): PlanType {
  return {
    credentialProblem: null,
    id: `${projectId}-producer`,
    projectId,
    role: 'producer',
    serves: { excludeTypes: ['bug'], states: ['build_ready'] },
    stateTriggered: true,
    ...overrides,
  };
}

function agent(
  id: string,
  typeId: string,
  projectId: string,
  free = true,
): PlanAgent {
  return { free, id, projectId, typeId };
}

function item(
  id: string,
  projectId: string,
  overrides: Partial<PlanItem> = {},
): PlanItem {
  return {
    claimableSince: at(0),
    id,
    priority: 'P2',
    projectId,
    state: 'build_ready',
    type: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<PlanSnapshot>): PlanSnapshot {
  return {
    agents: [],
    instanceLimit: 10,
    instanceRunning: 0,
    items: [],
    projects: [],
    types: [],
    ...overrides,
  };
}

describe('planning a dispatch', () => {
  test('pairs free agents with items, highest priority first, then oldest', () => {
    const plan = planDispatch(
      snapshot({
        agents: [
          agent('cyclops', 'a-producer', 'a'),
          agent('storm', 'a-producer', 'a'),
          agent('busy', 'a-producer', 'a', false),
        ],
        items: [
          item('old-p2', 'a', { claimableSince: at(1) }),
          item('new-p1', 'a', { claimableSince: at(5), priority: 'P1' }),
          item('newer-p2', 'a', { claimableSince: at(3) }),
        ],
        projects: [project('a', { limit: 5 })],
        types: [producer('a')],
      }),
    );

    expect(plan.pairings).toEqual([
      {
        agentId: 'cyclops',
        itemId: 'new-p1',
        projectId: 'a',
        typeId: 'a-producer',
      },
      {
        agentId: 'storm',
        itemId: 'old-p2',
        projectId: 'a',
        typeId: 'a-producer',
      },
    ]);
    expect(plan.waiting).toEqual([
      {
        itemId: 'newer-p2',
        reason: { kind: 'no_free_agent', role: 'producer' },
      },
    ]);
  });

  test('offers only what a state-triggered type serves', () => {
    const plan = planDispatch(
      snapshot({
        agents: [
          agent('cyclops', 'a-producer', 'a'),
          agent('bishop', 'a-bugfixer', 'a'),
          agent('emma', 'a-reviewer', 'a'),
        ],
        items: [
          item('review', 'a', { state: 'review_ready' }),
          item('fresh', 'a', { state: 'new' }),
          item('build', 'a'),
        ],
        projects: [project('a')],
        types: [
          producer('a'),
          producer('a', {
            id: 'a-bugfixer',
            role: 'bugfixer',
            serves: { states: ['build_ready'], types: ['bug'] },
          }),
          producer('a', {
            id: 'a-reviewer',
            role: 'reviewer',
            serves: { states: ['review_ready'] },
            stateTriggered: false,
          }),
        ],
      }),
    );

    expect(plan.pairings).toEqual([
      {
        agentId: 'cyclops',
        itemId: 'build',
        projectId: 'a',
        typeId: 'a-producer',
      },
    ]);
    expect(plan.waiting).toEqual([]);
  });

  test('holds a project at its limit, counting every run already going', () => {
    const plan = planDispatch(
      snapshot({
        agents: [
          agent('cyclops', 'a-producer', 'a'),
          agent('storm', 'a-producer', 'a'),
        ],
        items: [item('first', 'a', { priority: 'P1' }), item('second', 'a')],
        projects: [project('a', { limit: 3, running: 2 })],
        types: [producer('a')],
      }),
    );

    expect(plan.pairings.map((pairing) => pairing.itemId)).toEqual(['first']);
    expect(plan.waiting).toEqual([
      {
        itemId: 'second',
        reason: { kind: 'project_limit', limit: 3, running: 3 },
      },
    ]);
  });

  test('admits across projects in the order items became claimable', () => {
    const plan = planDispatch(
      snapshot({
        agents: [
          agent('a1', 'a-producer', 'a'),
          agent('a2', 'a-producer', 'a'),
          agent('b1', 'b-producer', 'b'),
        ],
        instanceLimit: 4,
        instanceRunning: 2,
        items: [
          item('a-urgent', 'a', { claimableSince: at(9), priority: 'P0' }),
          item('a-old', 'a', { claimableSince: at(1) }),
          item('b-mid', 'b', { claimableSince: at(5), priority: 'P3' }),
        ],
        projects: [project('a'), project('b')],
        types: [producer('a'), producer('b')],
      }),
    );

    expect(plan.pairings.map((pairing) => pairing.itemId)).toEqual([
      'b-mid',
      'a-urgent',
    ]);
    expect(plan.waiting).toEqual([
      {
        itemId: 'a-old',
        reason: { kind: 'instance_limit', limit: 4, running: 4 },
      },
    ]);
  });

  test('starts nothing in a paused project and says so on every item it would', () => {
    const plan = planDispatch(
      snapshot({
        agents: [
          agent('cyclops', 'a-producer', 'a'),
          agent('b1', 'b-producer', 'b'),
        ],
        items: [
          item('held', 'a'),
          item('other', 'b'),
          item('fresh', 'a', { state: 'new' }),
        ],
        projects: [project('a', { paused: true }), project('b')],
        types: [producer('a'), producer('b')],
      }),
    );

    expect(plan.pairings.map((pairing) => pairing.itemId)).toEqual(['other']);
    expect(plan.waiting).toEqual([
      { itemId: 'held', reason: { kind: 'paused' } },
    ]);
  });

  test('refuses a type whose credential is missing, before any limit', () => {
    const plan = planDispatch(
      snapshot({
        agents: [agent('cyclops', 'a-producer', 'a')],
        items: [item('blocked', 'a')],
        projects: [project('a', { limit: 1, running: 1 })],
        types: [producer('a', { credentialProblem: 'GitHub' })],
      }),
    );

    expect(plan.pairings).toEqual([]);
    expect(plan.waiting).toEqual([
      {
        itemId: 'blocked',
        reason: { kind: 'credential_missing', service: 'GitHub' },
      },
    ]);
  });

  test('names the project limit before the Cerebra-wide one, and both before a busy role', () => {
    const plan = planDispatch(
      snapshot({
        agents: [
          agent('busy', 'a-producer', 'a', false),
          agent('b1', 'b-producer', 'b', false),
        ],
        instanceLimit: 2,
        instanceRunning: 2,
        items: [item('a-item', 'a'), item('b-item', 'b')],
        projects: [
          project('a', { limit: 1, running: 1 }),
          project('b', { limit: 3, running: 1 }),
        ],
        types: [producer('a'), producer('b')],
      }),
    );

    expect(plan.waiting).toEqual([
      {
        itemId: 'a-item',
        reason: { kind: 'project_limit', limit: 1, running: 1 },
      },
      {
        itemId: 'b-item',
        reason: { kind: 'instance_limit', limit: 2, running: 2 },
      },
    ]);
  });

  test('blames the Cerebra-wide limit when it, not the project, held the work back', () => {
    const plan = planDispatch(
      snapshot({
        agents: [
          agent('a1', 'a-producer', 'a'),
          agent('a2', 'a-producer', 'a'),
          agent('a3', 'a-producer', 'a'),
        ],
        instanceLimit: 1,
        instanceRunning: 1,
        items: [
          item('first', 'a', { claimableSince: at(1) }),
          item('second', 'a', { claimableSince: at(2) }),
          item('third', 'a', { claimableSince: at(3) }),
        ],
        projects: [project('a', { limit: 2, running: 0 })],
        types: [producer('a')],
      }),
    );

    expect(plan.pairings).toEqual([]);
    expect(plan.waiting.map(({ reason }) => reason)).toEqual([
      { kind: 'instance_limit', limit: 1, running: 1 },
      { kind: 'instance_limit', limit: 1, running: 1 },
      { kind: 'instance_limit', limit: 1, running: 1 },
    ]);
  });

  test('says no role is free when a project has none of that type', () => {
    const plan = planDispatch(
      snapshot({
        items: [item('lonely', 'a', { state: 'design_ready' })],
        projects: [project('a')],
        types: [
          producer('a', {
            id: 'a-designer',
            role: 'designer',
            serves: { states: ['design_ready'] },
          }),
        ],
      }),
    );

    expect(plan.waiting).toEqual([
      { itemId: 'lonely', reason: { kind: 'no_free_agent', role: 'designer' } },
    ]);
  });
});
