import { useCallback, useEffect, useId, useRef, useState } from 'react';

import type {
  AttentionClient,
  AttentionEntry,
  AttentionKind,
} from './attention';

export interface AttentionCenterProps {
  readonly client: AttentionClient;
  /** Changing this closes the panel, so switching projects never replaces it in place. */
  readonly closeKey: string;
  readonly now?: () => Date;
  readonly onOpen: (entry: AttentionEntry) => void;
  readonly onOpenSettings: () => void;
  /** Changing this opens the panel, such as when a batched browser alert is selected. */
  readonly openSignal?: number;
  readonly pollIntervalMs?: number;
  /** Changing this reads the list at once, such as when the backend pushes. */
  readonly pushSignal: number;
}

const tags: Record<AttentionKind, string> = {
  question: 'QUESTION',
  trouble: 'TROUBLE',
  waiting: 'WAITING',
};

function age(since: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(since)) / 60_000);
  if (minutes < 1) return 'Now';
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

function clock(since: string): string {
  const time = new Date(since);
  return `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
}

function detail(entry: AttentionEntry, now: Date): string {
  switch (entry.kind) {
    case 'question':
      return [entry.projectName, entry.agentName, age(entry.since, now)]
        .filter((part) => part !== null)
        .join(' · ');
    case 'waiting':
      return `${entry.projectName} · Waiting since ${clock(entry.since)}`;
    case 'trouble':
      return `${entry.projectName} · Open the conversation to see what happened`;
  }
}

/** The header's attention control and its panel of questions, waits and trouble. */
export function AttentionCenter({
  client,
  closeKey,
  now = () => new Date(),
  onOpen,
  onOpenSettings,
  openSignal = 0,
  pollIntervalMs = 15_000,
  pushSignal,
}: AttentionCenterProps) {
  const [latest, setLatest] = useState<readonly AttentionEntry[] | null>(null);
  const [shown, setShown] = useState<readonly AttentionEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [updating, setUpdating] = useState(true);
  const request = useRef(0);
  const openRef = useRef(false);
  const loaded = useRef(false);
  const focusOnOpen = useRef(false);
  const control = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const firstEntry = useRef<HTMLButtonElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const headingId = useId();
  const countId = useId();

  const load = useCallback(async () => {
    const current = ++request.current;
    setUpdating(true);
    try {
      const entries = await client.list();
      if (current !== request.current) return;
      setLatest(entries);
      setFailed(false);
      const replace = !openRef.current || !loaded.current;
      loaded.current = true;
      setShown((previous) => {
        if (replace) return entries;
        const byId = new Map(entries.map((entry) => [entry.id, entry]));
        return previous.flatMap((entry) => byId.get(entry.id) ?? []);
      });
    } catch {
      if (current === request.current) setFailed(true);
    } finally {
      if (current === request.current) setUpdating(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), pollIntervalMs);
    return () => {
      window.clearInterval(timer);
      request.current += 1;
    };
  }, [load, pollIntervalMs]);

  const firstPush = useRef(true);
  useEffect(() => {
    if (firstPush.current) {
      firstPush.current = false;
      return;
    }
    void load();
  }, [pushSignal, load]);

  const show = useCallback(() => {
    openRef.current = true;
    focusOnOpen.current = true;
    setShown(latest ?? []);
    setOpen(true);
  }, [latest]);

  const close = useCallback((returnFocus: boolean) => {
    openRef.current = false;
    setOpen(false);
    if (returnFocus) control.current?.focus();
  }, []);

  const firstOpenSignal = useRef(true);
  useEffect(() => {
    if (firstOpenSignal.current) {
      firstOpenSignal.current = false;
      return;
    }
    show();
    // Only a new signal opens the panel; a changed list must not.
  }, [openSignal]);

  useEffect(() => {
    close(false);
  }, [closeKey, close]);

  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    if (latest === null && !failed) return;
    focusOnOpen.current = false;
    (firstEntry.current ?? settingsButton.current)?.focus();
  }, [open, shown, latest, failed]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (
        panel.current?.contains(target) ||
        control.current?.contains(target)
      ) {
        return;
      }
      close(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') close(true);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  const count = latest?.length ?? 0;
  const shownIds = new Set(shown.map((entry) => entry.id));
  const waiting = (latest ?? []).filter((entry) => !shownIds.has(entry.id));
  const at = now();

  return (
    <div className="mr-2">
      <button
        aria-controls={open ? panelId : undefined}
        aria-describedby={count > 0 ? countId : undefined}
        aria-expanded={open}
        aria-label="Open attention center"
        className="relative grid size-10 place-items-center rounded-lg border border-[var(--control-border)] bg-[var(--surface)] shadow-sm outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
        onClick={() => (open ? close(true) : show())}
        ref={control}
        type="button"
      >
        <svg
          aria-hidden="true"
          className="size-5"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {count > 0 ? (
          <span
            aria-hidden="true"
            className="absolute -top-2 -right-2 min-w-5 rounded-full bg-[var(--danger)] px-1.5 py-px text-xs font-bold text-white"
          >
            {count > 99 ? '99+' : count}
          </span>
        ) : null}
      </button>
      {count > 0 ? (
        <span className="sr-only" id={countId}>
          {count === 1 ? '1 item needs' : `${count} items need`} your attention
        </span>
      ) : null}
      {open ? (
        <section
          aria-labelledby={headingId}
          className="fixed top-[4.5rem] right-4 left-4 z-20 mt-2 max-h-[min(510px,calc(100vh-6rem))] overflow-auto rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2.5 shadow-xl sm:left-auto sm:right-[5vw] sm:w-[390px]"
          id={panelId}
          ref={panel}
        >
          <div className="flex items-center justify-between gap-3 px-2 pt-1.5 pb-2.5">
            <h2 className="text-base font-bold" id={headingId}>
              Needs your attention
            </h2>
            <button
              className="rounded-md px-2 py-1.5 text-sm font-bold text-[var(--accent)] outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
              onClick={() => {
                close(false);
                onOpenSettings();
              }}
              ref={settingsButton}
              type="button"
            >
              Notification settings
            </button>
          </div>
          {updating ? (
            <p className="px-2 pb-2 text-sm text-[var(--muted)]" role="status">
              Updating…
            </p>
          ) : null}
          {failed ? (
            <p className="px-2 pb-2 text-sm text-[var(--danger)]" role="alert">
              We couldn't load what needs your attention.{' '}
              <button
                className="font-bold underline outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
                onClick={() => void load()}
                type="button"
              >
                Try again
              </button>
              .
            </p>
          ) : null}
          {waiting.length > 0 ? (
            <button
              className="mx-2 mb-2 rounded-md bg-[var(--accent-muted)] px-3 py-1.5 text-sm font-bold text-[var(--accent)] outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
              onClick={() => setShown(latest ?? [])}
              type="button"
            >
              {waiting.length === 1
                ? '1 new item'
                : `${waiting.length} new items`}
            </button>
          ) : null}
          {latest !== null &&
          !failed &&
          shown.length === 0 &&
          waiting.length === 0 ? (
            <p className="px-2 py-3 text-sm text-[var(--muted)]">
              You're all caught up. We'll let you know when something needs you.
            </p>
          ) : null}
          {shown.length > 0 ? (
            <ul>
              {shown.map((entry, index) => (
                <li className="border-t border-[var(--border)]" key={entry.id}>
                  <button
                    className="block w-full rounded-md px-2.5 py-3 text-left outline-none hover:bg-[var(--accent-muted)] focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
                    onClick={() => {
                      close(false);
                      onOpen(entry);
                    }}
                    ref={index === 0 ? firstEntry : undefined}
                    type="button"
                  >
                    <span
                      className={`mb-1 inline-block rounded-full px-2 py-0.5 text-[11px] font-extrabold ${
                        entry.kind === 'trouble'
                          ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200'
                          : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200'
                      }`}
                    >
                      {tags[entry.kind]}
                    </span>
                    <strong className="block text-sm">{entry.title}</strong>
                    <span className="mt-0.5 block text-[13px] text-[var(--muted)]">
                      {detail(entry, at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
