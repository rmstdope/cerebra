import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { NotificationSettingsClient } from './notification-settings';
import { NotificationSettingsPage } from './notification-settings-page';
import type { NotificationApi } from './notifications';

afterEach(() => {
  cleanup();
});

function api(
  permission: NotificationApi['permission'],
  answer: NotificationApi['permission'] = permission,
) {
  const requestPermission = vi.fn(async () => answer);
  const value: NotificationApi = {
    permission,
    requestPermission,
    show: () => {},
  };
  return { api: value, requestPermission };
}

function client(
  overrides: Partial<NotificationSettingsClient> = {},
): NotificationSettingsClient & { set: ReturnType<typeof vi.fn> } {
  return {
    list: async () => [
      {
        browserNotifications: true,
        projectId: 'p1',
        projectName: 'acme/atlas',
      },
      {
        browserNotifications: false,
        projectId: 'p2',
        projectName: 'acme/compass',
      },
    ],
    set: vi.fn(async () => {}),
    ...overrides,
  } as NotificationSettingsClient & { set: ReturnType<typeof vi.fn> };
}

function toggle(project: string): HTMLElement {
  return within(screen.getByRole('group', { name: project })).getByRole(
    'switch',
    { name: 'Browser notifications' },
  );
}

test('each project has its own Browser notifications switch, saved through the client', async () => {
  const user = userEvent.setup();
  const settings = client();
  render(
    <NotificationSettingsPage
      client={settings}
      notificationApi={api('granted').api}
    />,
  );

  expect(await screen.findByRole('group', { name: 'acme/atlas' })).toBeTruthy();
  expect(toggle('acme/atlas').getAttribute('aria-checked')).toBe('true');
  expect(toggle('acme/compass').getAttribute('aria-checked')).toBe('false');

  await user.click(toggle('acme/atlas'));
  expect(settings.set).toHaveBeenCalledWith('p1', false);
  expect(toggle('acme/atlas').getAttribute('aria-checked')).toBe('false');
  expect(screen.queryByText(/blocked/)).toBeNull();
});

test('turning one on asks the browser for permission when it has not decided', async () => {
  const user = userEvent.setup();
  const settings = client();
  const { api: notificationApi, requestPermission } = api('default', 'denied');
  render(
    <NotificationSettingsPage
      client={settings}
      notificationApi={notificationApi}
    />,
  );
  await screen.findByRole('group', { name: 'acme/compass' });

  await user.click(toggle('acme/compass'));
  expect(requestPermission).toHaveBeenCalled();
  expect(settings.set).toHaveBeenCalledWith('p2', true);
  expect(
    await screen.findByText(
      'Browser notifications are blocked. Allow them in your browser settings to receive alerts.',
    ),
  ).toBeTruthy();
});

test('a blocked browser is explained', async () => {
  render(
    <NotificationSettingsPage
      client={client()}
      notificationApi={api('denied').api}
    />,
  );
  expect(
    await screen.findByText(
      'Browser notifications are blocked. Allow them in your browser settings to receive alerts.',
    ),
  ).toBeTruthy();
});

test('with no projects it says what to do first', async () => {
  render(
    <NotificationSettingsPage
      client={client({ list: async () => [] })}
      notificationApi={api('granted').api}
    />,
  );
  expect(
    await screen.findByText('Add a project to choose its notifications.'),
  ).toBeTruthy();
});

test('a failed load and a failed save say so; the switch keeps its saved value', async () => {
  const user = userEvent.setup();
  let fail = true;
  const settings = client({
    list: async () => {
      if (fail) throw new Error('down');
      return [
        {
          browserNotifications: true,
          projectId: 'p1',
          projectName: 'acme/atlas',
        },
      ];
    },
    set: vi.fn(async () => {
      throw new Error('down');
    }),
  });
  render(
    <NotificationSettingsPage
      client={settings}
      notificationApi={api('granted').api}
    />,
  );

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain(
    'Cerebra couldn’t load your notification settings.',
  );
  fail = false;
  await user.click(within(alert).getByRole('button', { name: 'Try again' }));
  await screen.findByRole('group', { name: 'acme/atlas' });

  await act(async () => {
    await user.click(toggle('acme/atlas'));
  });
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Cerebra couldn’t save this setting. Nothing has changed. Try again.',
  );
  expect(toggle('acme/atlas').getAttribute('aria-checked')).toBe('true');
});
