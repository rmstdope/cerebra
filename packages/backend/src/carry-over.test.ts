import type { Kysely } from 'kysely';
import { describe, expect, test } from 'vitest';

import { createBoard } from './board.js';
import {
  CarryOverError,
  carryOver,
  CarryOverManifestError,
  parseCarryOverManifest,
  type CarryOverManifest,
} from './carry-over.js';
import type { Database } from './database.js';
import { registerTestProject, withTestDatabase } from './test-support.js';

const carriedBody = (oldName: string) =>
  `Moved here from the old task list, where it was ${oldName}. Its priority, scope and what it waits on came with it.`;

async function itemCarriedFrom(database: Kysely<Database>, oldName: string) {
  return database
    .selectFrom('work_items')
    .select(['id', 'description', 'key', 'priority', 'state', 'title', 'type'])
    .where('carried_from', '=', oldName)
    .executeTakeFirstOrThrow();
}

async function itemCount(database: Kysely<Database>): Promise<number> {
  const row = await database
    .selectFrom('work_items')
    .select((builder) => builder.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

describe('carrying over open work from the old task list', () => {
  test('carries each item into its state with its priority, scope and one Carried over entry', async () => {
    await withTestDatabase(async (database) => {
      await registerTestProject(database, 'website');
      const board = createBoard(database);

      const carried = await carryOver(database, {
        items: [
          {
            description: 'Podman must honour volume subpaths.',
            oldName: 'cr-2co',
            priority: 'P1',
            state: 'build_ready',
            title: 'Refuse a Podman whose API ignores volume subpaths',
            type: 'bug',
          },
          {
            description: 'Light, dark or the system.',
            oldName: 'cr-2vd.7',
            priority: 'P2',
            state: 'design_ready',
            title: 'Let people choose the appearance',
            type: 'feature',
          },
          {
            description: '',
            oldName: 'cr-a1',
            priority: 'P3',
            state: 'grooming_ready',
            title: 'Groom me',
            type: 'task',
          },
          {
            description: '',
            oldName: 'cr-a2',
            state: 'new',
            title: 'Still unranked',
            type: 'refactoring',
          },
        ],
        project: 'acme/website',
      });

      expect(carried).toEqual([
        { key: 'WEB-1', oldName: 'cr-2co', state: 'build_ready' },
        { key: 'WEB-2', oldName: 'cr-2vd.7', state: 'design_ready' },
        { key: 'WEB-3', oldName: 'cr-a1', state: 'grooming_ready' },
        { key: 'WEB-4', oldName: 'cr-a2', state: 'new' },
      ]);

      const bug = await itemCarriedFrom(database, 'cr-2co');
      expect(bug).toMatchObject({
        description: 'Podman must honour volume subpaths.',
        priority: 'P1',
        state: 'build_ready',
        title: 'Refuse a Podman whose API ignores volume subpaths',
        type: 'bug',
      });
      expect(await board.getHistory(bug.id)).toEqual([
        expect.objectContaining({
          actorRole: 'navigator',
          fromState: 'new',
          kind: 'carried_over',
          reason: carriedBody('cr-2co'),
          toState: 'build_ready',
        }),
      ]);

      const unranked = await itemCarriedFrom(database, 'cr-a2');
      expect(unranked).toMatchObject({ priority: null, state: 'new' });
      expect(await board.getHistory(unranked.id)).toEqual([
        expect.objectContaining({
          fromState: 'new',
          kind: 'carried_over',
          reason: carriedBody('cr-a2'),
          toState: 'new',
        }),
      ]);
    });
  });

  test('files and cancels an item not carried over: Carried over, then Cancelled with the reason', async () => {
    await withTestDatabase(async (database) => {
      await registerTestProject(database, 'website');
      const board = createBoard(database);

      const carried = await carryOver(database, {
        items: [
          {
            description: 'Old epic.',
            notCarriedOver: 'already done by cr-cye.3',
            oldName: 'cr-9zz.2',
            title: 'Register a project',
            type: 'feature',
          },
          {
            description: '',
            notCarriedOver: 'a duplicate of cr-2co.',
            oldName: 'cr-9zz.3',
            priority: 'P2',
            title: 'Refuse subpaths',
            type: 'bug',
          },
        ],
        project: 'acme/website',
      });

      expect(carried).toEqual([
        { key: 'WEB-1', oldName: 'cr-9zz.2', state: 'cancelled' },
        { key: 'WEB-2', oldName: 'cr-9zz.3', state: 'cancelled' },
      ]);
      const done = await itemCarriedFrom(database, 'cr-9zz.2');
      expect(done).toMatchObject({ priority: null, state: 'cancelled' });
      expect(await board.getHistory(done.id)).toEqual([
        expect.objectContaining({
          fromState: 'new',
          kind: 'carried_over',
          reason: 'Moved here from the old task list, where it was cr-9zz.2.',
          toState: 'new',
        }),
        expect.objectContaining({
          actorRole: 'navigator',
          fromState: 'new',
          kind: 'transition',
          reason: 'Not carried over: already done by cr-cye.3.',
          toState: 'cancelled',
        }),
      ]);
      const duplicate = await itemCarriedFrom(database, 'cr-9zz.3');
      expect((await board.getHistory(duplicate.id))[1]?.reason).toBe(
        'Not carried over: a duplicate of cr-2co.',
      );
    });
  });

  test('refuses an old item named twice, or one already carried, and files nothing', async () => {
    await withTestDatabase(async (database) => {
      await registerTestProject(database, 'website');
      const item = {
        description: '',
        oldName: 'cr-2co',
        priority: 'P1',
        state: 'build_ready',
        title: 'Refuse subpaths',
        type: 'bug',
      } as const;

      await expect(
        carryOver(database, {
          items: [item, { ...item, title: 'Again' }],
          project: 'acme/website',
        }),
      ).rejects.toThrow(
        new CarryOverError('cr-2co is named more than once in the manifest.'),
      );
      expect(await itemCount(database)).toBe(0);

      await carryOver(database, { items: [item], project: 'acme/website' });
      await expect(
        carryOver(database, {
          items: [{ ...item, oldName: 'cr-other' }, item],
          project: 'acme/website',
        }),
      ).rejects.toThrow(
        new CarryOverError('cr-2co has already been carried over as WEB-1.'),
      );
      expect(await itemCount(database)).toBe(1);
    });
  });

  test('refuses a route to a stage the project has switched off, and files nothing', async () => {
    await withTestDatabase(async (database) => {
      const projectId = await registerTestProject(database, 'website');
      await database
        .updateTable('projects')
        .set({ design_enabled: false })
        .where('id', '=', projectId)
        .execute();
      const manifest: CarryOverManifest = {
        items: [
          {
            description: '',
            oldName: 'cr-ok',
            priority: 'P1',
            state: 'build_ready',
            title: 'Fine',
            type: 'task',
          },
          {
            description: '',
            oldName: 'cr-2vd.7',
            priority: 'P2',
            state: 'design_ready',
            title: 'Let people choose the appearance',
            type: 'feature',
          },
        ],
        project: 'acme/website',
      };

      await expect(carryOver(database, manifest)).rejects.toThrow(
        CarryOverError,
      );
      await expect(carryOver(database, manifest)).rejects.toThrow(/cr-2vd\.7/);
      expect(await itemCount(database)).toBe(0);
    });
  });

  test('refuses a project that is not registered', async () => {
    await withTestDatabase(async (database) => {
      await registerTestProject(database, 'website');
      await expect(
        carryOver(database, { items: [], project: 'acme/elsewhere' }),
      ).rejects.toThrow(
        new CarryOverError('No project acme/elsewhere is registered.'),
      );
    });
  });
});

describe('reading a carry-over manifest', () => {
  const carried = {
    description: 'Why.',
    oldName: 'cr-2co',
    priority: 'P1',
    state: 'build_ready',
    title: 'Refuse subpaths',
    type: 'bug',
  };

  test('accepts carried and not-carried items', () => {
    const notCarried = {
      notCarriedOver: 'already done',
      oldName: 'cr-x',
      title: 'Old',
      type: 'task',
    };
    expect(
      parseCarryOverManifest({
        items: [carried, notCarried],
        project: 'acme/website',
      }),
    ).toEqual({
      items: [carried, { ...notCarried, description: '' }],
      project: 'acme/website',
    });
  });

  test.each([
    [null, 'The manifest must be a JSON object.'],
    [{ items: [] }, 'The manifest must name its project as owner/name.'],
    [
      { items: {}, project: 'acme/website' },
      'The manifest must list its items.',
    ],
    [
      { items: [{ ...carried, oldName: ' ' }], project: 'acme/website' },
      'Item 1 must give its oldName.',
    ],
    [
      { items: [{ ...carried, title: '' }], project: 'acme/website' },
      'cr-2co must give its title.',
    ],
    [
      { items: [{ ...carried, type: 'epic' }], project: 'acme/website' },
      'cr-2co has type epic; use feature, bug, task or refactoring.',
    ],
    [
      { items: [{ ...carried, state: 'building' }], project: 'acme/website' },
      'cr-2co has state building; use new, grooming_ready, design_ready or build_ready.',
    ],
    [
      { items: [{ ...carried, priority: 'P4' }], project: 'acme/website' },
      'cr-2co has priority P4; use P0, P1, P2 or P3.',
    ],
    [
      { items: [{ ...carried, priority: undefined }], project: 'acme/website' },
      'cr-2co needs a priority to go to build_ready.',
    ],
    [
      { items: [{ ...carried, state: 'new' }], project: 'acme/website' },
      'cr-2co cannot keep a priority in new.',
    ],
    [
      { items: [{ ...carried, state: undefined }], project: 'acme/website' },
      'cr-2co must give a state, or notCarriedOver with a reason.',
    ],
    [
      {
        items: [{ ...carried, notCarriedOver: 'done' }],
        project: 'acme/website',
      },
      'cr-2co gives both a state and notCarriedOver; choose one.',
    ],
  ])('refuses %j', (manifest, message) => {
    expect(() => parseCarryOverManifest(manifest)).toThrow(
      new CarryOverManifestError(message),
    );
  });
});
