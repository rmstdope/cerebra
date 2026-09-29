import { useCallback, useEffect, useState, type ReactNode } from 'react';

import {
  browserNotificationSettingsClient,
  type NotificationSettingsClient,
  type ProjectNotificationSetting,
} from './notification-settings';
import {
  browserNotificationApi,
  type NotificationApi,
  type NotificationPermissionState,
} from './notifications';

function ProjectSetting({
  onChange,
  setting,
}: {
  readonly onChange: (on: boolean) => Promise<void>;
  readonly setting: ProjectNotificationSetting;
}): ReactNode {
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const headingId = `notifications-${setting.projectId}`;
  const on = setting.browserNotifications;

  return (
    <div aria-labelledby={headingId} className="card" role="group">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-bold break-all" id={headingId}>
          {setting.projectName}
        </h2>
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium" id={`${headingId}-label`}>
            Browser notifications
          </span>
          <button
            aria-checked={on}
            aria-labelledby={`${headingId}-label`}
            className={`relative h-6 w-11 shrink-0 rounded-full outline-none transition-colors focus-visible:ring-3 focus-visible:ring-[var(--focus)] motion-reduce:transition-none ${
              on ? 'bg-[var(--accent)]' : 'bg-[var(--control-border)]'
            }`}
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              setSaveFailed(false);
              try {
                await onChange(!on);
              } catch {
                setSaveFailed(true);
              } finally {
                setSaving(false);
              }
            }}
            role="switch"
            type="button"
          >
            <span
              aria-hidden="true"
              className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform motion-reduce:transition-none ${
                on ? 'translate-x-5' : ''
              }`}
            />
          </button>
        </div>
      </div>
      {saveFailed ? (
        <p className="auth-error" role="alert">
          Cerebra couldn’t save this setting. Nothing has changed. Try again.
        </p>
      ) : null}
    </div>
  );
}

/** Which projects raise browser alerts; the header count is never affected. */
export function NotificationSettingsPage({
  client = browserNotificationSettingsClient,
  notificationApi = browserNotificationApi(),
}: {
  readonly client?: NotificationSettingsClient;
  readonly notificationApi?: NotificationApi;
}): ReactNode {
  const [settings, setSettings] = useState<
    readonly ProjectNotificationSetting[] | null
  >(null);
  const [failed, setFailed] = useState(false);
  const [permission, setPermission] = useState<NotificationPermissionState>(
    notificationApi.permission,
  );

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setSettings(await client.list());
    } catch {
      setFailed(true);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function change(projectId: string, on: boolean): Promise<void> {
    if (on && permission === 'default') {
      setPermission(await notificationApi.requestPermission());
    }
    await client.set(projectId, on);
    setSettings(
      (current) =>
        current?.map((setting) =>
          setting.projectId === projectId
            ? { ...setting, browserNotifications: on }
            : setting,
        ) ?? null,
    );
  }

  return (
    <section aria-labelledby="notifications-heading">
      <h1
        className="text-3xl font-bold tracking-tight sm:text-4xl"
        id="notifications-heading"
      >
        Notifications
      </h1>
      <p className="mt-1 text-[var(--muted)]">
        Which projects send browser alerts for questions, waits and trouble.
      </p>
      {permission === 'denied' || permission === 'unsupported' ? (
        <p className="mt-6 rounded-lg border border-[var(--border)] bg-[var(--accent-muted)] p-4 text-sm">
          Browser notifications are blocked. Allow them in your browser settings
          to receive alerts.
        </p>
      ) : null}
      {failed ? (
        <p className="auth-error" role="alert">
          Cerebra couldn’t load your notification settings.{' '}
          <button
            className="font-bold underline"
            onClick={() => void load()}
            type="button"
          >
            Try again
          </button>
        </p>
      ) : settings === null ? (
        <div
          aria-busy="true"
          className="mt-8 h-40 animate-pulse rounded-lg bg-[var(--accent-muted)] motion-reduce:animate-none"
        >
          <span className="sr-only">Loading…</span>
        </div>
      ) : settings.length === 0 ? (
        <p className="card mt-8">Add a project to choose its notifications.</p>
      ) : (
        <div className="mt-8 grid gap-5">
          {settings.map((setting) => (
            <ProjectSetting
              key={setting.projectId}
              onChange={(on) => change(setting.projectId, on)}
              setting={setting}
            />
          ))}
        </div>
      )}
    </section>
  );
}
