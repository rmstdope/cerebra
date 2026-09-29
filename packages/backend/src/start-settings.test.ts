import { describe, expect, test } from 'vitest';

import { ProjectNotFoundError } from './board.js';
import { createStartSettings, LimitInputError } from './start-settings.js';
import { registerTestProject, withTestDatabase } from './test-support.js';

describe('start settings', () => {
  test('keeps a project’s pause until it is resumed', async () => {
    await withTestDatabase(async (database) => {
      const settings = createStartSettings(database);
      const projectId = await registerTestProject(database);
      const other = await registerTestProject(database, 'docs');

      expect(await settings.paused(projectId)).toBe(false);
      await settings.setPaused(projectId, true);

      expect(await createStartSettings(database).paused(projectId)).toBe(true);
      expect(await settings.paused(other)).toBe(false);
      await settings.setPaused(projectId, false);
      expect(await settings.paused(projectId)).toBe(false);
    });
  });

  test('reads and saves both limits', async () => {
    await withTestDatabase(async (database) => {
      const settings = createStartSettings(database);
      const projectId = await registerTestProject(database);

      expect(await settings.limits(projectId)).toEqual({
        instanceLimit: 3,
        projectLimit: 1,
      });
      expect(await settings.limits()).toEqual({
        instanceLimit: 3,
        projectLimit: null,
      });
      expect(await settings.setInstanceLimit(6)).toEqual({
        instanceLimit: 6,
        projectLimit: null,
      });
      expect(await settings.setProjectLimit(projectId, 6)).toEqual({
        instanceLimit: 6,
        projectLimit: 6,
      });
      expect(await settings.limits(projectId)).toEqual({
        instanceLimit: 6,
        projectLimit: 6,
      });
    });
  });

  test.each([0, -1, 1.5, null, '', '2', Number.NaN, 2 ** 31])(
    'refuses %s as a limit and saves nothing',
    async (value) => {
      await withTestDatabase(async (database) => {
        const settings = createStartSettings(database);
        const projectId = await registerTestProject(database);

        await expect(
          settings.setProjectLimit(projectId, value),
        ).rejects.toEqual(
          new LimitInputError('Enter a whole number of 1 or more.'),
        );
        await expect(settings.setInstanceLimit(value)).rejects.toEqual(
          new LimitInputError('Enter a whole number of 1 or more.'),
        );
        expect(await settings.limits(projectId)).toEqual({
          instanceLimit: 3,
          projectLimit: 1,
        });
      });
    },
  );

  test('refuses a project limit above the Cerebra-wide limit', async () => {
    await withTestDatabase(async (database) => {
      const settings = createStartSettings(database);
      const projectId = await registerTestProject(database);

      await expect(settings.setProjectLimit(projectId, 4)).rejects.toEqual(
        new LimitInputError(
          "This can't be higher than the Cerebra-wide limit (3).",
        ),
      );
      expect((await settings.limits(projectId)).projectLimit).toBe(1);
    });
  });

  test('answers an unknown project as not found', async () => {
    await withTestDatabase(async (database) => {
      const settings = createStartSettings(database);
      const missing = crypto.randomUUID();

      await expect(settings.paused(missing)).rejects.toBeInstanceOf(
        ProjectNotFoundError,
      );
      await expect(settings.setPaused('nope', true)).rejects.toBeInstanceOf(
        ProjectNotFoundError,
      );
      await expect(settings.limits(missing)).rejects.toBeInstanceOf(
        ProjectNotFoundError,
      );
      await expect(settings.setProjectLimit(missing, 1)).rejects.toBeInstanceOf(
        ProjectNotFoundError,
      );
    });
  });
});
