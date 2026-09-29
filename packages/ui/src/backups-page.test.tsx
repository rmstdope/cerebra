import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';

import type { BackupStatus, BackupsClient } from './backups';
import { BackupsPage } from './backups-page';

afterEach(cleanup);

// Local times, so the page reads the same in any time zone.
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 8, day, hour, minute).toISOString();
const now = () => new Date(2026, 8, 28, 14, 0);

const schedule = {
  keep: 7,
  location: '~/cerebra-backups',
  nextAt: at(29, 2),
};

const upToDate: BackupStatus = {
  backups: [
    {
      at: at(28, 2, 14),
      cause: null,
      id: '2',
      sizeBytes: 48_200_000,
      status: 'completed',
    },
    {
      at: at(27, 2, 13),
      cause: null,
      id: '1',
      sizeBytes: 47_900_000,
      status: 'completed',
    },
  ],
  kept: 2,
  running: null,
  schedule,
};

function client(
  ...statuses: Array<BackupStatus | Error>
): BackupsClient & { started: number } {
  const queue = [...statuses];
  const next = async () => {
    const status = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (status instanceof Error) throw status;
    return status;
  };
  const fake = {
    started: 0,
    start: async () => {
      fake.started += 1;
      return next();
    },
    status: next,
  };
  return fake;
}

test('shows the latest backup, the kept list and the schedule', async () => {
  render(<BackupsPage client={client(upToDate)} now={now} />);

  expect(
    screen.getByRole('heading', { level: 1, name: 'Backups' }),
  ).toBeTruthy();
  expect(
    screen.getByText(
      'Cerebra saves a daily copy of this instance so it can be restored if needed.',
    ),
  ).toBeTruthy();
  expect(await screen.findByText('Backups are up to date')).toBeTruthy();
  expect(
    screen.getByText('The latest backup finished today at 02:14.'),
  ).toBeTruthy();

  const recent = screen.getByRole('region', { name: 'Recent backups' });
  expect(
    within(recent).getByText(
      '2 backups kept. Older ones are removed automatically.',
    ),
  ).toBeTruthy();
  const rows = within(recent).getAllByRole('listitem');
  expect(rows.map((row) => row.textContent)).toEqual([
    'Today, 02:14Completed48.2 MB',
    'Yesterday, 02:13Completed47.9 MB',
  ]);

  const card = screen.getByRole('region', { name: 'Backup schedule' });
  expect(
    [...card.querySelectorAll('dt, dd')].map((cell) => cell.textContent),
  ).toEqual([
    'Runs',
    'Every day at 02:00',
    'Next backup',
    'Tomorrow, 02:00',
    'Saved to',
    '~/cerebra-backups',
    'Keeps',
    'The last 7 backups',
  ]);
  expect(
    within(card).getByText(
      'These settings are part of how Cerebra was installed. To change them, edit the install settings and restart Cerebra.',
    ),
  ).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: 'Back up now' }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test('starts a backup and shows it running', async () => {
  const running: BackupStatus = {
    ...upToDate,
    running: { startedAt: at(28, 14, 2) },
  };
  const fake = client(upToDate, running);
  render(<BackupsPage client={fake} now={now} />);

  await userEvent.click(
    await screen.findByRole('button', { name: 'Back up now' }),
  );

  expect(await screen.findByText('Backing up…')).toBeTruthy();
  expect(
    screen.getByText('Started at 14:02. You can keep working.'),
  ).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: 'Back up now' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByText('A backup is already running.')).toBeTruthy();
  expect(fake.started).toBe(1);
});

test('says when the first backup runs before there is one', async () => {
  render(
    <BackupsPage
      client={client({ backups: [], kept: 0, running: null, schedule })}
      now={now}
    />,
  );

  expect(await screen.findByText('No backups yet')).toBeTruthy();
  expect(
    screen.getByText('The first backup runs tonight at 02:00.'),
  ).toBeTruthy();
  expect(
    screen.getByText(
      'No completed backups yet. They’ll appear here once the first one finishes.',
    ),
  ).toBeTruthy();
});

test('names a failed backup and keeps the earlier ones listed', async () => {
  render(
    <BackupsPage
      client={client({
        ...upToDate,
        backups: [
          {
            at: at(28, 2),
            cause: 'the backup folder is full',
            id: '3',
            sizeBytes: null,
            status: 'failed',
          },
          upToDate.backups[1]!,
        ],
        kept: 1,
      })}
      now={now}
    />,
  );

  expect(await screen.findByText('The last backup didn’t finish')).toBeTruthy();
  expect(
    screen.getByText(
      'Tonight’s backup at 02:00 failed: the backup folder is full. Your earlier backups are untouched. Cerebra will try again at the next scheduled time.',
    ),
  ).toBeTruthy();
  const rows = within(
    screen.getByRole('region', { name: 'Recent backups' }),
  ).getAllByRole('listitem');
  expect(rows.map((row) => row.textContent)).toEqual([
    'Today, 02:00Failed — the backup folder is full. Nothing was kept.—',
    'Yesterday, 02:13Completed47.9 MB',
  ]);
  expect(
    (screen.getByRole('button', { name: 'Back up now' }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

test('reports a status that cannot be read, never an empty list', async () => {
  render(
    <BackupsPage client={client(new Error('down'), upToDate)} now={now} />,
  );

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Couldn’t load backup status');
  expect(alert.textContent).toContain(
    'Cerebra couldn’t read its backup records. This doesn’t mean backups are missing.',
  );
  expect(screen.queryByText(/No backups yet|No completed backups/)).toBeNull();

  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

  expect(await screen.findByText('Backups are up to date')).toBeTruthy();
});

test('reports a backup that could not be started', async () => {
  const fake = client(upToDate);
  fake.start = async () => {
    throw new Error('down');
  };
  render(<BackupsPage client={fake} now={now} />);

  await userEvent.click(
    await screen.findByRole('button', { name: 'Back up now' }),
  );

  expect((await screen.findByRole('alert')).textContent).toBe(
    'Cerebra couldn’t start a backup. Try again.',
  );
  expect(screen.getByText('Backups are up to date')).toBeTruthy();
});
