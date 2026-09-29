import { describe, expect, test } from 'vitest';

import { ProjectNotFoundError } from './board.js';
import {
  createInvolvementSettings,
  InvolvementInputError,
} from './involvement.js';
import { registerTestProject, withTestDatabase } from './test-support.js';

describe('involvement settings', () => {
  test('starts autonomous and keeps each project’s own choice', async () => {
    await withTestDatabase(async (database) => {
      const settings = createInvolvementSettings(database);
      const projectId = await registerTestProject(database);
      const other = await registerTestProject(database, 'docs');

      expect(await settings.get(projectId)).toEqual({
        involvement: 'autonomous',
        reviewAccount: null,
      });

      expect(
        await settings.set(projectId, {
          involvement: 'full',
          reviewAccount: ' @Navigator ',
        }),
      ).toEqual({ involvement: 'full', reviewAccount: 'Navigator' });
      expect(await createInvolvementSettings(database).get(projectId)).toEqual(
        { involvement: 'full', reviewAccount: 'Navigator' },
      );
      expect(await settings.get(other)).toEqual({
        involvement: 'autonomous',
        reviewAccount: null,
      });

      expect(
        await settings.set(projectId, {
          involvement: 'plan',
          reviewAccount: 'navigator',
        }),
      ).toEqual({ involvement: 'plan', reviewAccount: 'navigator' });
    });
  });

  test('refuses full involvement without an account and saves nothing', async () => {
    await withTestDatabase(async (database) => {
      const settings = createInvolvementSettings(database);
      const projectId = await registerTestProject(database);

      for (const reviewAccount of [null, '', '  ', '@']) {
        await expect(
          settings.set(projectId, { involvement: 'full', reviewAccount }),
        ).rejects.toThrow(
          new InvolvementInputError(
            'Enter the GitHub account whose review counts.',
          ),
        );
      }
      expect(await settings.get(projectId)).toEqual({
        involvement: 'autonomous',
        reviewAccount: null,
      });
    });
  });

  test.each([
    [{ involvement: 'sometimes', reviewAccount: null }],
    [{ involvement: 'plan', reviewAccount: 3 }],
    [{ involvement: 'full', reviewAccount: 'not a login!' }],
    [null],
    ['full'],
  ])('refuses %j', async (input) => {
    await withTestDatabase(async (database) => {
      const settings = createInvolvementSettings(database);
      const projectId = await registerTestProject(database);

      await expect(settings.set(projectId, input)).rejects.toBeInstanceOf(
        InvolvementInputError,
      );
    });
  });

  test('reports a project that does not exist', async () => {
    await withTestDatabase(async (database) => {
      const settings = createInvolvementSettings(database);
      const missing = '00000000-0000-4000-8000-000000000000';

      await expect(settings.get(missing)).rejects.toBeInstanceOf(
        ProjectNotFoundError,
      );
      await expect(
        settings.set(missing, { involvement: 'plan', reviewAccount: null }),
      ).rejects.toBeInstanceOf(ProjectNotFoundError);
      await expect(settings.get('not-a-uuid')).rejects.toBeInstanceOf(
        ProjectNotFoundError,
      );
    });
  });
});
