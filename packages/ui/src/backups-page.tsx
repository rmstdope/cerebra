import { useCallback, useEffect, useState, type ReactNode } from 'react';

import {
  browserBackupsClient,
  clock,
  failedSentence,
  finishedSentence,
  firstBackupSentence,
  keepsLabel,
  keptSentence,
  sizeLabel,
  whenLabel,
  type BackupStatus,
  type BackupsClient,
} from './backups';

const runningRefreshMs = 3_000;
const idleRefreshMs = 30_000;

type Tone = 'ok' | 'running' | 'info' | 'bad';

const tones: Record<Tone, { readonly icon: string; readonly style: string }> = {
  bad: {
    icon: '!',
    style: 'bg-red-50 text-[var(--danger)] dark:bg-red-950',
  },
  info: { icon: 'i', style: 'bg-[var(--accent-muted)]' },
  ok: {
    icon: '✓',
    style: 'bg-green-50 text-[var(--success)] dark:bg-green-950',
  },
  running: { icon: '⟳', style: 'bg-amber-50 dark:bg-amber-950' },
};

function Notice({
  role,
  text,
  title,
  tone,
}: {
  readonly role?: 'alert' | 'status';
  readonly text: string;
  readonly title: string;
  readonly tone: Tone;
}): ReactNode {
  return (
    <div
      className={`mt-8 flex gap-3 rounded-lg p-4 ${tones[tone].style}`}
      role={role}
    >
      <span aria-hidden="true" className="font-bold">
        {tones[tone].icon}
      </span>
      <p className="grid gap-1">
        <b>{title}</b>
        <span className="text-[var(--foreground)]">{text}</span>
      </p>
    </div>
  );
}

function statusNotice(status: BackupStatus, now: Date): ReactNode {
  const latest = status.backups[0];
  if (status.running !== null) {
    return (
      <Notice
        role="status"
        text={`Started at ${clock(new Date(status.running.startedAt))}. You can keep working.`}
        title="Backing up…"
        tone="running"
      />
    );
  }
  if (latest?.status === 'failed') {
    return (
      <Notice
        text={failedSentence(new Date(latest.at), latest.cause ?? '', now)}
        title="The last backup didn’t finish"
        tone="bad"
      />
    );
  }
  if (latest === undefined) {
    return (
      <Notice
        text={firstBackupSentence(new Date(status.schedule.nextAt), now)}
        title="No backups yet"
        tone="info"
      />
    );
  }
  return (
    <Notice
      text={finishedSentence(new Date(latest.at), now)}
      title="Backups are up to date"
      tone="ok"
    />
  );
}

/** The instance's database backups: what is kept, and when the next runs (architecture §10). */
export function BackupsPage({
  client = browserBackupsClient,
  now = () => new Date(),
}: {
  readonly client?: BackupsClient;
  readonly now?: () => Date;
}): ReactNode {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [startFailed, setStartFailed] = useState(false);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await client.status());
      setFailed(false);
    } catch {
      // A status that cannot be read is never shown as the last one read, or as no backups.
      setStatus(null);
      setFailed(true);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const running = status?.running != null;
  useEffect(() => {
    if (status === null) return;
    const timer = setTimeout(
      () => void load(),
      running ? runningRefreshMs : idleRefreshMs,
    );
    return () => clearTimeout(timer);
  }, [load, running, status]);

  const start = async () => {
    setStartFailed(false);
    setStarting(true);
    try {
      setStatus(await client.start());
    } catch {
      setStartFailed(true);
    } finally {
      setStarting(false);
    }
  };

  const current = now();

  return (
    <section aria-labelledby="backups-heading">
      <p className="text-sm font-bold text-[var(--muted)]">Settings</p>
      <h1
        className="rounded-lg text-3xl font-bold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)] sm:text-4xl"
        id="backups-heading"
        tabIndex={-1}
      >
        Backups
      </h1>
      <p className="mt-1 text-[var(--muted)]">
        Cerebra saves a daily copy of this instance so it can be restored if
        needed.
      </p>
      {failed ? (
        <>
          <div role="alert">
            <Notice
              text="Cerebra couldn’t read its backup records. This doesn’t mean backups are missing."
              title="Couldn’t load backup status"
              tone="bad"
            />
          </div>
          <button
            className="secondary-button mt-4"
            onClick={() => void load()}
            type="button"
          >
            Try again
          </button>
        </>
      ) : status === null ? (
        <div
          aria-busy="true"
          className="mt-8 h-40 animate-pulse rounded-lg bg-[var(--accent-muted)] motion-reduce:animate-none"
        >
          <span className="sr-only">Loading…</span>
        </div>
      ) : (
        <>
          {statusNotice(status, current)}
          <div className="mt-6 grid items-start gap-5 md:grid-cols-[3fr_2fr]">
            <section aria-labelledby="recent-backups-heading" className="card">
              <h2 className="text-lg font-bold" id="recent-backups-heading">
                Recent backups
              </h2>
              <p className="mt-1 text-sm text-[var(--muted)]">
                {status.kept === 0
                  ? 'No completed backups yet. They’ll appear here once the first one finishes.'
                  : keptSentence(status.kept)}
              </p>
              {status.backups.length === 0 ? null : (
                <ul className="mt-4 divide-y divide-[var(--border)]">
                  {status.backups.map((backup) => (
                    <li
                      className="flex items-start justify-between gap-4 py-3"
                      key={backup.id}
                    >
                      <div className="grid gap-0.5">
                        <b>{whenLabel(new Date(backup.at), current)}</b>
                        <span
                          className={`text-sm ${
                            backup.status === 'failed'
                              ? 'text-[var(--danger)]'
                              : 'text-[var(--muted)]'
                          }`}
                        >
                          {backup.status === 'failed'
                            ? `Failed — ${backup.cause ?? ''}. Nothing was kept.`
                            : 'Completed'}
                        </span>
                      </div>
                      <span className="shrink-0 text-sm tabular-nums">
                        {backup.sizeBytes === null
                          ? '—'
                          : sizeLabel(backup.sizeBytes)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-labelledby="backup-schedule-heading" className="card">
              <h2 className="text-lg font-bold" id="backup-schedule-heading">
                Backup schedule
              </h2>
              <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-[var(--muted)]">Runs</dt>
                <dd>{`Every day at ${clock(new Date(status.schedule.nextAt))}`}</dd>
                <dt className="text-[var(--muted)]">Next backup</dt>
                <dd>{whenLabel(new Date(status.schedule.nextAt), current)}</dd>
                <dt className="text-[var(--muted)]">Saved to</dt>
                <dd className="break-all">
                  <code>{status.schedule.location}</code>
                </dd>
                <dt className="text-[var(--muted)]">Keeps</dt>
                <dd>{keepsLabel(status.schedule.keep)}</dd>
              </dl>
              <p className="mt-4 text-sm text-[var(--muted)]">
                These settings are part of how Cerebra was installed. To change
                them, edit the install settings and restart Cerebra.
              </p>
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <button
                  aria-describedby={running ? 'backup-running' : undefined}
                  className="primary-button"
                  disabled={running || starting}
                  onClick={() => void start()}
                  type="button"
                >
                  Back up now
                </button>
                {running ? (
                  <span
                    className="text-sm text-[var(--muted)]"
                    id="backup-running"
                  >
                    A backup is already running.
                  </span>
                ) : null}
              </div>
              {startFailed ? (
                <p className="auth-error" role="alert">
                  Cerebra couldn’t start a backup. Try again.
                </p>
              ) : null}
            </section>
          </div>
        </>
      )}
    </section>
  );
}
