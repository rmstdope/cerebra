export interface ProjectNotificationSetting {
  readonly browserNotifications: boolean;
  readonly projectId: string;
  readonly projectName: string;
}

export interface NotificationSettingsClient {
  list(): Promise<readonly ProjectNotificationSetting[]>;
  set(projectId: string, browserNotifications: boolean): Promise<void>;
}

async function request(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}.`);
  }
  return response.json();
}

export const browserNotificationSettingsClient: NotificationSettingsClient = {
  async list() {
    return (await request(
      '/api/notification-settings',
    )) as readonly ProjectNotificationSetting[];
  },
  async set(projectId, browserNotifications) {
    await request(
      `/api/projects/${encodeURIComponent(projectId)}/notification-settings`,
      {
        body: JSON.stringify({ browserNotifications }),
        headers: { 'content-type': 'application/json' },
        method: 'PUT',
      },
    );
  },
};
