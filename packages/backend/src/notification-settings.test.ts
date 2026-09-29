import { describe, expect, test } from 'vitest';

import { ProjectNotFoundError } from './board.js';
import { createNotificationSettings } from './notification-settings.js';
import { registerTestProject, withTestDatabase } from './test-support.js';

describe('notification settings', { concurrent: false }, () => {
  test('every project notifies by default, and turning one off is kept', async () => {
    await withTestDatabase(async (database) => {
      const website = await registerTestProject(database, 'website');
      const atlas = await registerTestProject(database, 'atlas');
      const settings = createNotificationSettings(database);

      expect(await settings.list()).toEqual([
        {
          browserNotifications: true,
          projectId: atlas,
          projectName: 'acme/atlas',
        },
        {
          browserNotifications: true,
          projectId: website,
          projectName: 'acme/website',
        },
      ]);

      await settings.set(atlas, false);

      expect(await settings.mutedProjects()).toEqual(new Set([atlas]));
      expect(await createNotificationSettings(database).list()).toContainEqual({
        browserNotifications: false,
        projectId: atlas,
        projectName: 'acme/atlas',
      });
      await settings.set(atlas, true);
      expect(await settings.mutedProjects()).toEqual(new Set());
    });
  });

  test('an unknown project is refused', async () => {
    await withTestDatabase(async (database) => {
      await expect(
        createNotificationSettings(database).set(crypto.randomUUID(), false),
      ).rejects.toBeInstanceOf(ProjectNotFoundError);
      await expect(
        createNotificationSettings(database).set('nope', false),
      ).rejects.toBeInstanceOf(ProjectNotFoundError);
    });
  });
});
