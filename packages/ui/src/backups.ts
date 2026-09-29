export interface BackupRecord {
  /** When it finished if it completed; when it started if it failed. */
  readonly at: string;
  readonly cause: string | null;
  readonly id: string;
  readonly sizeBytes: number | null;
  readonly status: 'completed' | 'failed';
}

export interface BackupStatus {
  /** Kept backups and recent failed attempts, newest first; a running one is not listed. */
  readonly backups: readonly BackupRecord[];
  readonly kept: number;
  readonly running: { readonly startedAt: string } | null;
  readonly schedule: {
    readonly keep: number;
    readonly location: string;
    readonly nextAt: string;
  };
}

export interface BackupsClient {
  status(): Promise<BackupStatus>;
  /** Starts a backup; resolves with the status either way, since one may already be running. */
  start(): Promise<BackupStatus>;
}

export class BackupRequestError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'BackupRequestError';
  }
}

async function request(url: string, init?: RequestInit): Promise<BackupStatus> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      code?: string;
      error?: string;
    } | null;
    throw new BackupRequestError(
      body?.error ?? `Request failed with status ${response.status}.`,
      body?.code ?? null,
    );
  }
  return (await response.json()) as BackupStatus;
}

export const browserBackupsClient: BackupsClient = {
  status: () => request('/api/settings/backups'),
  async start() {
    try {
      return await request('/api/settings/backups', { method: 'POST' });
    } catch (error) {
      if (
        error instanceof BackupRequestError &&
        error.code === 'already_running'
      ) {
        return request('/api/settings/backups');
      }
      throw error;
    }
  },
};

const weekdays = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const pad = (value: number) => String(value).padStart(2, '0');

/** The local 24-hour time, "02:14". */
export function clock(at: Date): string {
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** Whole local calendar days from `now` to `at`; negative in the past. */
function dayOffset(at: Date, now: Date): number {
  const day = (date: Date) =>
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((day(at) - day(now)) / 86_400_000);
}

/** "Today", "Yesterday", "Tomorrow", a weekday within a week, else "12 Sep". */
export function dayLabel(at: Date, now: Date): string {
  const offset = dayOffset(at, now);
  if (offset === 0) return 'Today';
  if (offset === -1) return 'Yesterday';
  if (offset === 1) return 'Tomorrow';
  if (Math.abs(offset) < 7) return weekdays[at.getDay()]!;
  return `${at.getDate()} ${months[at.getMonth()]}`;
}

/** A list or schedule time, "Today, 02:14". */
export function whenLabel(at: Date, now: Date): string {
  return `${dayLabel(at, now)}, ${clock(at)}`;
}

/** The queue's time, "Today at 02:00". */
export function queueWhen(at: Date, now: Date): string {
  return `${dayLabel(at, now)} at ${clock(at)}`;
}

/** Inside a sentence: "today at 02:14", "yesterday at 02:14", "on Sunday at 02:14". */
function sentenceWhen(at: Date, now: Date): string {
  const offset = dayOffset(at, now);
  const day = dayLabel(at, now);
  return Math.abs(offset) <= 1
    ? `${day.toLowerCase()} at ${clock(at)}`
    : `on ${day} at ${clock(at)}`;
}

const isNightHour = (at: Date) => at.getHours() < 6 || at.getHours() >= 18;

/** "The latest backup finished today at 02:14." */
export function finishedSentence(at: Date, now: Date): string {
  return `The latest backup finished ${sentenceWhen(at, now)}.`;
}

/** "The first backup runs tonight at 02:00." */
export function firstBackupSentence(nextAt: Date, now: Date): string {
  const offset = dayOffset(nextAt, now);
  const tonight =
    isNightHour(nextAt) &&
    (offset === 0 || (offset === 1 && nextAt.getHours() < 6));
  return `The first backup runs ${
    tonight ? `tonight at ${clock(nextAt)}` : sentenceWhen(nextAt, now)
  }.`;
}

/** "Tonight’s backup at 02:00 failed: the backup folder is full. …" */
export function failedSentence(at: Date, cause: string, now: Date): string {
  const offset = dayOffset(at, now);
  const tonight =
    isNightHour(at) && (offset === 0 || (offset === -1 && at.getHours() >= 18));
  const day = dayLabel(at, now);
  const which = tonight
    ? `Tonight’s backup at ${clock(at)}`
    : Math.abs(offset) < 7
      ? `${day}’s backup at ${clock(at)}`
      : `The backup on ${day} at ${clock(at)}`;
  return `${which} failed: ${cause}. Your earlier backups are untouched. Cerebra will try again at the next scheduled time.`;
}

/** Decimal units: "812 KB", "48.2 MB", "1.3 GB". */
export function sizeLabel(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  let text = value.toFixed(digits);
  // Rounding can reach the next unit: 999.96 KB is 1.0 MB.
  if (Number(text) >= 1000 && unit < units.length - 1) {
    unit += 1;
    text = (Number(text) / 1000).toFixed(1);
  }
  return `${text} ${units[unit]}`;
}

export function keptSentence(kept: number): string {
  return `${kept} ${kept === 1 ? 'backup' : 'backups'} kept. Older ones are removed automatically.`;
}

export function keepsLabel(keep: number): string {
  return keep === 1 ? 'The last backup' : `The last ${keep} backups`;
}
