import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

import { queueWhen } from './backups';
import { BoardRequestError, type BoardRoute, type Priority } from './board';
import { routes } from './project-board';
import {
  browserQueueClient,
  type QueueClient,
  type QueueEntry,
  type QueueEntryKind,
  type QueueNotice,
  type QueuePage,
} from './queue';

type QueueStorage = Pick<Storage, 'getItem' | 'setItem'>;
type Direction = 'cancel' | 'redirect' | 'reopen';
export type WorkTab = 'discussion' | 'overview';

interface Remembered {
  readonly collapsed: readonly string[];
  readonly count: number;
  readonly selected: string | null;
}

const storageKey = 'cerebra.queue';

const kindLabels: Record<QueueEntryKind, string> = {
  attention: 'Needs attention',
  new: 'New',
  question: 'Question',
  review: 'Review',
};

const kindBadges: Record<QueueEntryKind, string> = {
  attention: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100',
  new: 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-100',
  question: 'bg-amber-100 text-amber-950 dark:bg-amber-900 dark:text-amber-50',
  review: 'bg-blue-100 text-blue-900 dark:bg-blue-950 dark:text-blue-100',
};

const directions: readonly {
  readonly description: string;
  readonly label: string;
  readonly value: Direction;
}[] = [
  {
    description: 'Send it back to be worked on again.',
    label: 'Reopen this work',
    value: 'reopen',
  },
  {
    description: 'End it with a reason.',
    label: 'Cancel this work',
    value: 'cancel',
  },
  {
    description: 'Override the current direction with a reason.',
    label: 'Choose another next step',
    value: 'redirect',
  },
];

/** The checkpoint an entry waits at; none when the backend sent none. */
function checkpointOf(entry: QueueEntry): QueueEntry['checkpoint'] {
  return entry.checkpoint ?? null;
}

/** Whether the request is answered in the queue's own panel, not on its run or item. */
function opensHere(entry: QueueEntry): boolean {
  return entry.run === null && !entry.blocked && checkpointOf(entry) === null;
}

function asker(entry: QueueEntry): string {
  return entry.askedBy ?? 'Cerebra';
}

function nextNeeded(entry: QueueEntry): string {
  switch (entry.kind) {
    case 'attention':
      return 'Choose what happens next';
    case 'question':
      return `${asker(entry)} needs your answer`;
    case 'review':
      return 'Ready for your review';
    case 'new':
      return 'Needs a priority and next step';
  }
}

export function waitingFor(since: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(since)) / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

function browserStorage(): QueueStorage {
  try {
    return window.localStorage;
  } catch {
    return { getItem: () => null, setItem: () => undefined };
  }
}

function readRemembered(storage: QueueStorage): Remembered {
  try {
    const stored = JSON.parse(
      storage.getItem(storageKey) ?? 'null',
    ) as Partial<Remembered> | null;
    if (stored === null || typeof stored !== 'object') throw new Error();
    return {
      collapsed: Array.isArray(stored.collapsed)
        ? stored.collapsed.filter((id) => typeof id === 'string')
        : [],
      count:
        typeof stored.count === 'number' && stored.count >= 0
          ? stored.count
          : 0,
      selected: typeof stored.selected === 'string' ? stored.selected : null,
    };
  } catch {
    return { collapsed: [], count: 0, selected: null };
  }
}

function groupByProject(
  entries: readonly QueueEntry[],
): { id: string; name: string; entries: QueueEntry[] }[] {
  const groups: { id: string; name: string; entries: QueueEntry[] }[] = [];
  for (const entry of entries) {
    const group = groups.find((candidate) => candidate.id === entry.projectId);
    if (group === undefined) {
      groups.push({
        entries: [entry],
        id: entry.projectId,
        name: entry.projectName,
      });
    } else {
      group.entries.push(entry);
    }
  }
  return groups;
}

export function NavigatorQueue({
  client = browserQueueClient,
  now = () => new Date(),
  onCountChange,
  onOpenBackups = () => undefined,
  onOpenConversation = () => undefined,
  onViewWork,
  openRequest = null,
  pollIntervalMs = 30_000,
  storage: storageOverride,
}: {
  readonly client?: QueueClient;
  readonly now?: () => Date;
  readonly onCountChange?: (count: number) => void;
  /** Opens Settings → Backups from a failed-backup notice. */
  readonly onOpenBackups?: () => void;
  /** Opens the conversation of the run that asked a question. */
  readonly onOpenConversation?: (runId: string) => void;
  readonly onViewWork: (
    projectId: string,
    itemId: string,
    tab: WorkTab,
  ) => void;
  /** A fresh object selects that work item after the queue is read again. */
  readonly openRequest?: { readonly id: string } | null;
  readonly pollIntervalMs?: number;
  readonly storage?: QueueStorage;
}): ReactNode {
  const [storage] = useState<QueueStorage>(
    () => storageOverride ?? browserStorage(),
  );
  const [remembered] = useState(() => readRemembered(storage));
  const [shown, setShown] = useState<QueuePage | null>(null);
  const [total, setTotal] = useState(remembered.count);
  const [notices, setNotices] = useState<readonly QueueNotice[]>([]);
  const [arrivals, setArrivals] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshError, setRefreshError] = useState(false);
  const [collapsed, setCollapsed] = useState<readonly string[]>(
    remembered.collapsed,
  );
  const [selectedId, setSelectedId] = useState<string | null>(
    remembered.selected,
  );
  const [answer, setAnswer] = useState('');
  const [direction, setDirection] = useState<Direction | null>(null);
  const [priority, setPriority] = useState<Priority>('P2');
  const [route, setRoute] = useState<BoardRoute | null>(null);
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [focusTarget, setFocusTarget] = useState<
    | { kind: 'row'; id: string }
    | { kind: 'heading' }
    | { kind: 'save' }
    | { kind: 'dialog' }
    | null
  >(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const saveControl = useRef<HTMLButtonElement>(null);
  const dialogHeading = useRef<HTMLHeadingElement>(null);
  const shownIds = useRef<ReadonlySet<string> | null>(null);
  const loadRequest = useRef(0);

  const load = useCallback(async (): Promise<QueuePage | null> => {
    const request = ++loadRequest.current;
    setLoading(true);
    try {
      const next = await client.list();
      if (request !== loadRequest.current) return null;
      shownIds.current = new Set(next.entries.map((entry) => entry.id));
      setShown(next);
      setTotal(next.total);
      setNotices(next.notices);
      setArrivals(0);
      setRefreshError(false);
      setSelectedId((current) =>
        current !== null &&
        next.entries.some((entry) => entry.id === current && opensHere(entry))
          ? current
          : null,
      );
      return next;
    } catch {
      if (request === loadRequest.current) setRefreshError(true);
      return null;
    } finally {
      if (request === loadRequest.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (shownIds.current === null) return;
      const request = loadRequest.current;
      client
        .list()
        .then((next) => {
          if (request !== loadRequest.current || shownIds.current === null)
            return;
          const known = shownIds.current;
          setTotal(next.total);
          setNotices(next.notices);
          setArrivals(
            next.entries.filter((entry) => !known.has(entry.id)).length,
          );
          setRefreshError(false);
        })
        .catch(() => {
          if (request === loadRequest.current) setRefreshError(true);
        });
    }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [client, pollIntervalMs]);

  useEffect(() => {
    onCountChange?.(total + notices.length);
  }, [notices.length, onCountChange, total]);

  useEffect(() => {
    try {
      storage.setItem(
        storageKey,
        JSON.stringify({ collapsed, count: total, selected: selectedId }),
      );
    } catch {
      // Remembering the queue is best effort; it still works without it.
    }
  }, [collapsed, selectedId, storage, total]);

  useEffect(() => {
    if (focusTarget === null) return;
    if (focusTarget.kind === 'row') {
      (rows.current.get(focusTarget.id) ?? heading.current)?.focus();
    }
    if (focusTarget.kind === 'heading') heading.current?.focus();
    if (focusTarget.kind === 'save') saveControl.current?.focus();
    if (focusTarget.kind === 'dialog') dialogHeading.current?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  const closeDialog = () => {
    setConfirming(false);
    setFocusTarget({ kind: 'save' });
  };
  const escape = useRef<() => boolean>(() => false);
  escape.current = () => {
    if (!confirming) return false;
    closeDialog();
    return true;
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (escape.current()) event.preventDefault();
    };
    // Capture runs before the board's own Escape handler, which then leaves it alone.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const resetDetail = () => {
    setAnswer('');
    setDirection(null);
    setPriority('P2');
    setRoute(null);
    setReason('');
    setActionError(null);
    setConfirming(false);
  };

  const select = (id: string) => {
    if (id === selectedId) return;
    resetDetail();
    setSelectedId(id);
  };

  useEffect(() => {
    if (openRequest === null) return;
    let cancelled = false;
    resetDetail();
    setSelectedId(openRequest.id);
    void load().then((next) => {
      if (cancelled) return;
      const project = next?.entries.find(
        (entry) => entry.id === openRequest.id,
      )?.projectId;
      if (project !== undefined) {
        setCollapsed((current) => current.filter((id) => id !== project));
      }
      setFocusTarget({ kind: 'row', id: openRequest.id });
    });
    return () => {
      cancelled = true;
    };
    // Only a new request selects; the reader it calls is stable per client.
  }, [openRequest]);

  const back = () => {
    const id = selectedId;
    resetDetail();
    setSelectedId(null);
    if (id !== null) setFocusTarget({ kind: 'row', id });
  };

  const toggleProject = (projectId: string) =>
    setCollapsed((current) =>
      current.includes(projectId)
        ? current.filter((id) => id !== projectId)
        : [...current, projectId],
    );

  const entries = shown?.entries ?? [];
  const selected =
    entries.find((entry) => entry.id === selectedId && opensHere(entry)) ??
    null;
  const groups = groupByProject(entries);
  const visible = groups.flatMap((group) =>
    collapsed.includes(group.id) ? [] : group.entries,
  );

  const complete = (id: string) => {
    const index = visible.findIndex((entry) => entry.id === id);
    const following = visible[index + 1] ?? visible[index - 1] ?? null;
    shownIds.current = new Set(
      [...(shownIds.current ?? [])].filter((known) => known !== id),
    );
    setShown((current) =>
      current === null
        ? current
        : {
            ...current,
            entries: current.entries.filter((entry) => entry.id !== id),
            total: Math.max(0, current.total - 1),
          },
    );
    setTotal((current) => Math.max(0, current - 1));
    resetDetail();
    setSelectedId(null);
    setFocusTarget(
      following === null
        ? { kind: 'heading' }
        : { kind: 'row', id: following.id },
    );
  };

  const sendAnswer = async () => {
    if (selected === null || !answer.trim() || sending) return;
    const id = selected.id;
    setSending(true);
    setActionError(null);
    try {
      await client.answer(id, answer.trim());
      complete(id);
    } catch {
      setActionError('Cerebra couldn’t save your answer. Try again.');
    } finally {
      setSending(false);
    }
  };

  const saveDecision = async () => {
    if (selected === null || direction === null || sending) return;
    const id = selected.id;
    setSending(true);
    setActionError(null);
    try {
      if (direction === 'reopen') {
        await client.decide(id, { direction: 'reopen' });
      } else if (direction === 'cancel') {
        await client.decide(id, { direction: 'cancel', reason: reason.trim() });
      } else if (route !== null) {
        await client.decide(id, {
          direction: 'redirect',
          ...(selected.kind === 'new' ? { priority } : {}),
          reason: reason.trim(),
          to: route,
        });
      }
      complete(id);
    } catch (error) {
      if (confirming) setFocusTarget({ kind: 'save' });
      setConfirming(false);
      setActionError(
        error instanceof BoardRequestError && error.code === 'route_unavailable'
          ? 'That next step is not available for this project. Choose another route.'
          : 'Cerebra couldn’t save your decision. Try again.',
      );
    } finally {
      setSending(false);
    }
  };

  const decisionReady =
    direction === 'reopen' ||
    (direction === 'cancel' && reason.trim() !== '') ||
    (direction === 'redirect' && route !== null && reason.trim() !== '');

  const requestSave = () => {
    if (!decisionReady || sending) return;
    if (direction === 'cancel') {
      setConfirming(true);
      setFocusTarget({ kind: 'dialog' });
      return;
    }
    void saveDecision();
  };

  const panelOpen = selected !== null;
  // While Cerebra itself needs the navigator, the queue is not "all caught up".
  const empty = shown !== null && entries.length === 0 && notices.length === 0;
  const refreshFailure = refreshError ? (
    <p className="auth-error mt-4" role="alert">
      Cerebra couldn’t refresh what needs you. The requests already shown may be
      out of date.{' '}
      <button
        className="font-bold underline"
        onClick={() => void load()}
        type="button"
      >
        Try again
      </button>
    </p>
  ) : null;

  return (
    <section aria-labelledby="navigator-queue-heading">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h2
            className="text-3xl font-bold tracking-tight outline-none sm:text-4xl"
            id="navigator-queue-heading"
            ref={heading}
            tabIndex={-1}
          >
            What needs you
          </h2>
          <p className="mt-1 text-[var(--muted)]">
            Questions and decisions from every project, in one place.
          </p>
        </div>
        {shown !== null && !empty ? (
          <button
            className="secondary-button"
            disabled={loading}
            onClick={() => void load()}
            type="button"
          >
            Refresh queue
          </button>
        ) : null}
      </div>
      <div aria-live="polite" className="mt-4 empty:hidden" role="status">
        {arrivals > 0 ? (
          <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-50">
            {arrivals === 1 ? '1 new request' : `${arrivals} new requests`} —{' '}
            <button
              className="font-bold underline"
              onClick={() => void load()}
              type="button"
            >
              Refresh queue
            </button>
          </p>
        ) : null}
      </div>
      {refreshFailure}
      {notices.length > 0 ? (
        <section aria-label="Cerebra" className="card mt-5 grid gap-4 p-5">
          {notices.map((notice) => (
            <div
              className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
              key={notice.kind}
            >
              <div>
                <p className="font-bold">Backup failed</p>
                <p className="text-sm text-[var(--muted)]">
                  {`${queueWhen(new Date(notice.at), now())} · ${notice.cause}`}
                </p>
              </div>
              <button
                className="secondary-button self-start sm:self-auto"
                onClick={onOpenBackups}
                type="button"
              >
                Open Backups
              </button>
            </div>
          ))}
        </section>
      ) : null}
      {empty ? (
        <div className="card mt-5 py-12 text-center">
          <p className="text-xl font-bold">You’re all caught up.</p>
          <p className="mt-2 text-[var(--muted)]">
            There are no questions or decisions waiting for you.
          </p>
          <button
            className="secondary-button mt-5"
            disabled={loading}
            onClick={() => void load()}
            type="button"
          >
            {loading ? 'Loading…' : 'Refresh queue'}
          </button>
        </div>
      ) : (shown === null && refreshError) ||
        (shown !== null && entries.length === 0) ? null : (
        <div className="mt-5 grid gap-5 lg:grid-cols-[1.25fr_.9fr]">
          <section
            aria-label="Navigator queue"
            className={`card p-0 ${panelOpen ? 'hidden lg:block' : ''}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] p-5">
              <h3 className="text-lg font-bold">Waiting for you</h3>
              <span className="text-sm text-[var(--muted)]">
                {shown !== null && loading ? 'Loading… ' : ''}
                {shown !== null
                  ? `${total} ${total === 1 ? 'request' : 'requests'}`
                  : ''}
              </span>
            </div>
            {shown === null ? (
              <div
                aria-busy="true"
                className="m-5 h-40 animate-pulse rounded-lg bg-[var(--accent-muted)] motion-reduce:animate-none"
              >
                <span className="sr-only">Loading…</span>
              </div>
            ) : (
              groups.map((group) => {
                const open = !collapsed.includes(group.id);
                return (
                  <div key={group.id}>
                    <button
                      aria-controls={`queue-project-${group.id}`}
                      aria-expanded={open}
                      className="flex w-full items-center gap-2 border-b border-[var(--border)] bg-[var(--accent-muted)]/40 px-5 py-3 text-left text-sm font-bold text-[var(--muted)] outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-[var(--focus)]"
                      onClick={() => toggleProject(group.id)}
                      type="button"
                    >
                      <span aria-hidden="true">{open ? '▾' : '▸'}</span>
                      {group.name}
                    </button>
                    <div hidden={!open} id={`queue-project-${group.id}`}>
                      {open
                        ? group.entries.map((entry) =>
                            entry.run !== null &&
                            checkpointOf(entry) === null ? (
                              <div
                                className="grid grid-cols-1 gap-2 border-b border-[var(--border)] p-4 sm:grid-cols-[auto_1fr_auto] sm:items-center sm:gap-3"
                                data-run={entry.run.id}
                                key={entry.id}
                              >
                                <span
                                  className={`w-max self-start rounded-full px-2 py-1 text-xs font-bold ${kindBadges.question}`}
                                >
                                  {kindLabels.question}
                                </span>
                                <span className="min-w-0">
                                  <strong className="block break-words">
                                    {`${asker(entry)} asks: ${entry.title}`}
                                  </strong>
                                  <span className="mt-1 block text-sm text-[var(--muted)]">
                                    {`Waiting ${waitingFor(entry.since, now())}`}
                                  </span>
                                </span>
                                <button
                                  className="primary-button w-max"
                                  onClick={() => {
                                    if (entry.run !== null) {
                                      onOpenConversation(entry.run.id);
                                    }
                                  }}
                                  ref={(element) => {
                                    if (element === null)
                                      rows.current.delete(entry.id);
                                    else rows.current.set(entry.id, element);
                                  }}
                                  type="button"
                                >
                                  Answer
                                </button>
                              </div>
                            ) : entry.blocked ||
                              checkpointOf(entry) !== null ? (
                              <div
                                className="grid grid-cols-1 gap-2 border-b border-[var(--border)] p-4 sm:grid-cols-[auto_1fr_auto] sm:items-center sm:gap-3"
                                data-blocked={
                                  entry.blocked ? entry.id : undefined
                                }
                                data-checkpoint={
                                  checkpointOf(entry) ?? undefined
                                }
                                key={entry.id}
                              >
                                <span
                                  className={`w-max self-start rounded-full px-2 py-1 text-xs font-bold ${kindBadges[checkpointOf(entry) === null ? 'attention' : 'review']}`}
                                >
                                  {
                                    kindLabels[
                                      checkpointOf(entry) === null
                                        ? 'attention'
                                        : 'review'
                                    ]
                                  }
                                </span>
                                <span className="min-w-0">
                                  <strong className="block break-words">
                                    {entry.title}
                                  </strong>
                                  <span className="mt-1 block text-sm break-words text-[var(--muted)]">
                                    {`${entry.waitingReason ?? ''} · ${entry.projectName}`}
                                  </span>
                                </span>
                                <button
                                  className="primary-button w-max"
                                  onClick={() => {
                                    if (entry.run !== null) {
                                      onOpenConversation(entry.run.id);
                                    } else {
                                      onViewWork(
                                        entry.projectId,
                                        entry.id,
                                        'overview',
                                      );
                                    }
                                  }}
                                  ref={(element) => {
                                    if (element === null)
                                      rows.current.delete(entry.id);
                                    else rows.current.set(entry.id, element);
                                  }}
                                  type="button"
                                >
                                  Open
                                </button>
                              </div>
                            ) : (
                              <button
                                aria-current={
                                  selectedId === entry.id ? 'true' : undefined
                                }
                                className={`grid w-full grid-cols-1 gap-2 border-b border-[var(--border)] p-4 text-left outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-[var(--focus)] sm:grid-cols-[auto_1fr] sm:gap-3 ${selectedId === entry.id ? 'bg-[var(--accent-muted)] shadow-[inset_3px_0_var(--accent)]' : ''}`}
                                key={entry.id}
                                onClick={() => select(entry.id)}
                                ref={(element) => {
                                  if (element === null)
                                    rows.current.delete(entry.id);
                                  else rows.current.set(entry.id, element);
                                }}
                                type="button"
                              >
                                <span
                                  className={`w-max self-start rounded-full px-2 py-1 text-xs font-bold ${kindBadges[entry.kind]}`}
                                >
                                  {kindLabels[entry.kind]}
                                </span>
                                <span className="min-w-0">
                                  <strong className="block break-words">
                                    {entry.title}
                                  </strong>
                                  <span className="mt-1 block text-sm text-[var(--muted)]">
                                    {nextNeeded(entry)}
                                  </span>
                                </span>
                              </button>
                            ),
                          )
                        : null}
                    </div>
                  </div>
                );
              })
            )}
          </section>
          <aside
            aria-label="Selected request"
            className={`card ${panelOpen ? 'fixed inset-0 z-20 overflow-y-auto rounded-none lg:static lg:rounded-2xl' : 'hidden min-h-80 lg:block'}`}
          >
            {shown === null ? (
              <div
                aria-busy="true"
                className="h-40 animate-pulse rounded-lg bg-[var(--accent-muted)] motion-reduce:animate-none"
              >
                <span className="sr-only">Loading…</span>
              </div>
            ) : selected !== null ? (
              <RequestDetail
                actionError={actionError}
                answer={answer}
                confirming={confirming}
                dialogHeading={dialogHeading}
                direction={direction}
                decisionReady={decisionReady}
                entry={selected}
                loading={loading}
                onAnswer={setAnswer}
                onBack={back}
                onConfirmCancel={() => void saveDecision()}
                onDirection={(next) => {
                  setDirection(next);
                  setActionError(null);
                }}
                onKeep={closeDialog}
                onPriority={setPriority}
                onReason={setReason}
                onRoute={(next) => {
                  setRoute(next);
                  setActionError(null);
                }}
                onSave={requestSave}
                onSendAnswer={() => void sendAnswer()}
                onViewWork={(tab) =>
                  onViewWork(selected.projectId, selected.id, tab)
                }
                priority={priority}
                reason={reason}
                route={route}
                saveControl={saveControl}
                sending={sending}
              />
            ) : null}
          </aside>
        </div>
      )}
    </section>
  );
}

function RequestDetail({
  actionError,
  answer,
  confirming,
  decisionReady,
  dialogHeading,
  direction,
  entry,
  loading,
  onAnswer,
  onBack,
  onConfirmCancel,
  onDirection,
  onKeep,
  onPriority,
  onReason,
  onRoute,
  onSave,
  onSendAnswer,
  onViewWork,
  priority,
  reason,
  route,
  saveControl,
  sending,
}: {
  readonly actionError: string | null;
  readonly answer: string;
  readonly confirming: boolean;
  readonly decisionReady: boolean;
  readonly dialogHeading: RefObject<HTMLHeadingElement | null>;
  readonly direction: Direction | null;
  readonly entry: QueueEntry;
  readonly loading: boolean;
  readonly onAnswer: (value: string) => void;
  readonly onBack: () => void;
  readonly onConfirmCancel: () => void;
  readonly onDirection: (value: Direction) => void;
  readonly onKeep: () => void;
  readonly onPriority: (value: Priority) => void;
  readonly onReason: (value: string) => void;
  readonly onRoute: (value: BoardRoute) => void;
  readonly onSave: () => void;
  readonly onSendAnswer: () => void;
  readonly onViewWork: (tab: WorkTab) => void;
  readonly priority: Priority;
  readonly reason: string;
  readonly route: BoardRoute | null;
  readonly saveControl: RefObject<HTMLButtonElement | null>;
  readonly sending: boolean;
}): ReactNode {
  const eyebrow =
    entry.kind === 'question'
      ? `Question from ${asker(entry)} · ${entry.projectName}`
      : `${kindLabels[entry.kind]} · ${entry.projectName}`;
  const offered = directions.filter(
    (candidate) => entry.kind !== 'new' || candidate.value !== 'reopen',
  );
  const nextSteps = routes.filter((option) =>
    entry.availableRoutes.includes(option.value),
  );

  return (
    <>
      <button
        className="secondary-button mb-4 lg:hidden"
        onClick={onBack}
        type="button"
      >
        Back to what needs you
      </button>
      <p className="text-xs font-extrabold uppercase tracking-widest text-[var(--muted)]">
        {eyebrow}
        {loading ? (
          <span className="ml-2 font-normal normal-case tracking-normal">
            Loading…
          </span>
        ) : null}
      </p>
      <h3 className="mt-2 text-xl font-bold break-words">{entry.title}</h3>
      {entry.description ? (
        <p className="mt-2 text-sm whitespace-pre-wrap break-words text-[var(--muted)]">
          {entry.description}
        </p>
      ) : null}
      {entry.kind === 'question' ? (
        <form
          className="mt-5 border-t border-[var(--border)] pt-5"
          onSubmit={(event) => {
            event.preventDefault();
            onSendAnswer();
          }}
        >
          <div className="rounded-lg border border-[var(--accent)]/40 bg-[var(--accent-muted)] p-4">
            <strong className="block">{asker(entry)} asks</strong>
            <p className="mt-1 whitespace-pre-wrap break-words">
              {`“${entry.waitingReason ?? ''}”`}
            </p>
          </div>
          <label className="auth-label" htmlFor="queue-answer">
            Your answer
          </label>
          <textarea
            className="auth-input min-h-24"
            id="queue-answer"
            onChange={(event) => onAnswer(event.target.value)}
            placeholder="Write your answer…"
            readOnly={sending}
            value={answer}
          />
          {actionError !== null ? (
            <p className="auth-error" role="alert">
              {actionError}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              className="primary-button"
              disabled={sending || !answer.trim()}
              type="submit"
            >
              {sending ? 'Sending…' : 'Send answer'}
            </button>
            <button
              className="secondary-button"
              onClick={() => onViewWork('discussion')}
              type="button"
            >
              Open conversation
            </button>
            <button
              className="secondary-button"
              onClick={() => onViewWork('overview')}
              type="button"
            >
              View work
            </button>
          </div>
        </form>
      ) : (
        <form
          className="mt-5 border-t border-[var(--border)] pt-5"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          {entry.waitingReason ? (
            <p className="mb-4 whitespace-pre-wrap break-words">
              {entry.waitingReason}
            </p>
          ) : null}
          <fieldset disabled={sending}>
            <legend className="font-bold">Choose what happens next</legend>
            <div className="mt-2 grid gap-2">
              {offered.map((option) => (
                <label
                  className="flex gap-3 rounded-lg border border-[var(--control-border)] p-3 has-checked:border-[var(--accent)] has-checked:bg-[var(--accent-muted)]"
                  key={option.value}
                >
                  <input
                    aria-describedby={`queue-direction-${option.value}-hint`}
                    checked={direction === option.value}
                    className="mt-1"
                    name="queue-direction"
                    onChange={() => onDirection(option.value)}
                    type="radio"
                    value={option.value}
                  />
                  <span>
                    <strong className="block">{option.label}</strong>
                    <span
                      className="text-sm text-[var(--muted)]"
                      id={`queue-direction-${option.value}-hint`}
                    >
                      {option.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {direction === 'redirect' ? (
            <>
              {entry.kind === 'new' ? (
                <fieldset className="mt-4" disabled={sending}>
                  <legend className="text-sm font-bold">Priority</legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(['P1', 'P2', 'P3'] as const).map((value) => (
                      <label
                        className="flex items-center gap-2 rounded-lg border border-[var(--control-border)] px-3 py-2 has-checked:border-[var(--accent)] has-checked:bg-[var(--accent-muted)]"
                        key={value}
                      >
                        <input
                          checked={priority === value}
                          name="queue-priority"
                          onChange={() => onPriority(value)}
                          type="radio"
                          value={value}
                        />
                        {value}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              <fieldset className="mt-4" disabled={sending}>
                <legend className="text-sm font-bold">
                  Where should this go next?
                </legend>
                <div className="mt-2 grid gap-2">
                  {nextSteps.map((option) => (
                    <label
                      className="flex gap-3 rounded-lg border border-[var(--control-border)] p-3 has-checked:border-[var(--accent)] has-checked:bg-[var(--accent-muted)]"
                      key={option.value}
                    >
                      <input
                        aria-describedby={`queue-route-${option.value}-hint`}
                        checked={route === option.value}
                        className="mt-1"
                        name="queue-route"
                        onChange={() => onRoute(option.value)}
                        type="radio"
                        value={option.value}
                      />
                      <span>
                        <strong className="block">{option.label}</strong>
                        <span
                          className="text-sm text-[var(--muted)]"
                          id={`queue-route-${option.value}-hint`}
                        >
                          {option.description}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </>
          ) : null}
          {direction === 'cancel' || direction === 'redirect' ? (
            <>
              <label className="auth-label" htmlFor="queue-reason">
                Reason
              </label>
              <textarea
                className="auth-input min-h-20"
                id="queue-reason"
                onChange={(event) => onReason(event.target.value)}
                readOnly={sending}
                required
                value={reason}
              />
            </>
          ) : null}
          {actionError !== null ? (
            <p className="auth-error" role="alert">
              {actionError}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              className="primary-button"
              disabled={sending || !decisionReady}
              ref={saveControl}
              type="submit"
            >
              {sending ? 'Saving…' : 'Save decision'}
            </button>
            <button
              className="secondary-button"
              onClick={() => onViewWork('overview')}
              type="button"
            >
              View work
            </button>
          </div>
          {confirming ? (
            <div
              aria-labelledby="queue-cancel-heading"
              aria-modal="true"
              className="mt-5 rounded-lg border border-[var(--border)] p-4"
              role="dialog"
            >
              <h4
                className="font-bold outline-none"
                id="queue-cancel-heading"
                ref={dialogHeading}
                tabIndex={-1}
              >
                Cancel this work?
              </h4>
              <p className="mt-2 text-sm text-[var(--muted)]">
                This ends the work and records your reason.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  className="secondary-button"
                  onClick={onKeep}
                  type="button"
                >
                  Keep work
                </button>
                <button
                  className="primary-button"
                  disabled={sending}
                  onClick={onConfirmCancel}
                  type="button"
                >
                  Cancel work
                </button>
              </div>
            </div>
          ) : null}
        </form>
      )}
    </>
  );
}
