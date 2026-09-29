import type { Kysely } from 'kysely';

import { ProjectNotFoundError } from './board.js';
import type { Database } from './database.js';
import { projectLabel } from './navigator-queue.js';
import { isUuid } from './runs.js';

export interface ProjectNotificationSetting {
  readonly browserNotifications: boolean;
  readonly projectId: string;
  readonly projectName: string;
}

/** Which projects may raise browser notifications; every project may until it is turned off. */
export interface NotificationSettings {
  list(): Promise<readonly ProjectNotificationSetting[]>;
  mutedProjects(): Promise<ReadonlySet<string>>;
  set(projectId: string, browserNotifications: boolean): Promise<void>;
}

export function createNotificationSettings(
  database: Kysely<Database>,
): NotificationSettings {
  return {
    async list() {
      const rows = await database
        .selectFrom('projects')
        .select(['id', 'name', 'owner', 'browser_notifications'])
        .execute();
      return rows
        .map((row) => ({
          browserNotifications: row.browser_notifications,
          projectId: row.id,
          projectName: projectLabel(row.name, row.owner),
        }))
        .sort(
          (a, b) =>
            a.projectName.localeCompare(b.projectName) ||
            a.projectId.localeCompare(b.projectId),
        );
    },

    async mutedProjects() {
      const rows = await database
        .selectFrom('projects')
        .select('id')
        .where('browser_notifications', '=', false)
        .execute();
      return new Set(rows.map((row) => row.id));
    },

    async set(projectId, browserNotifications) {
      const result = isUuid(projectId)
        ? await database
            .updateTable('projects')
            .set({ browser_notifications: browserNotifications })
            .where('id', '=', projectId)
            .executeTakeFirst()
        : undefined;
      if (result === undefined || result.numUpdatedRows === 0n) {
        throw new ProjectNotFoundError(projectId);
      }
    },
  };
}
