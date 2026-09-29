import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type DeliveryEvent = {
  readonly agentName: string | null;
  readonly at: string;
  readonly id: string;
  readonly runId: string | null;
} & (
  | { readonly kind: 'plan' }
  | { readonly kind: 'checks'; readonly passed: boolean }
  | {
      readonly kind: 'pull_request';
      readonly number: number;
      readonly title: string | null;
      readonly url: string;
    }
);

type ChecksEvent = Extract<DeliveryEvent, { kind: 'checks' }>;
type PullRequestEvent = Extract<DeliveryEvent, { kind: 'pull_request' }>;

export type DeliveryCurrent =
  | { readonly kind: 'waiting_for_review'; readonly reviewer: string | null }
  | { readonly kind: 'plan_approval'; readonly runId: string }
  | null;

export interface DeliveryActivityPage {
  readonly current: DeliveryCurrent;
  readonly earlierCursor: string | null;
  readonly events: readonly DeliveryEvent[];
  readonly latestChecks: ChecksEvent | null;
  readonly latestPullRequest: PullRequestEvent | null;
}

export interface DeliveryActivityClient {
  read(itemId: string, before?: string): Promise<DeliveryActivityPage>;
}

export const browserDeliveryActivityClient: DeliveryActivityClient = {
  read: async (itemId, before) => {
    const query =
      before === undefined ? '' : `?before=${encodeURIComponent(before)}`;
    const response = await fetch(
      `/api/work-items/${encodeURIComponent(itemId)}/delivery-activity${query}`,
    );
    if (!response.ok) {
      throw new Error(`Delivery activity read failed (${response.status})`);
    }
    return (await response.json()) as DeliveryActivityPage;
  },
};

/** The states whose Overview tells a delivery story. */
export const deliveryStates: ReadonlySet<string> = new Set([
  'build_ready',
  'building',
  'review_ready',
  'reviewing',
  'merging',
  'waiting',
  'done',
]);

const currentSteps: Readonly<Record<string, string>> = {
  build_ready: 'Waiting for a builder',
  building: 'Building',
  done: 'Done',
  merging: 'Merging',
  review_ready: 'Independent review',
  reviewing: 'Independent review',
  waiting: 'Waiting',
};

const focusKey = 'cerebraDeliveryFocus';

interface DeliveryFocus {
  readonly itemId: string;
  readonly linkId: string;
}

/** The trail link to refocus on returning to the board, if Back led here from one. */
export function rememberedDeliveryFocus(): DeliveryFocus | null {
  const state: unknown = window.history.state;
  if (state === null || typeof state !== 'object') return null;
  const focus = (state as Record<string, unknown>)[focusKey];
  if (focus === null || typeof focus !== 'object') return null;
  const { itemId, linkId } = focus as Record<string, unknown>;
  return typeof itemId === 'string' && typeof linkId === 'string'
    ? { itemId, linkId }
    : null;
}

function writeFocus(focus: DeliveryFocus | null): void {
  const state: unknown = window.history.state;
  const base =
    state !== null && typeof state === 'object'
      ? (state as Record<string, unknown>)
      : {};
  window.history.replaceState({ ...base, [focusKey]: focus }, '');
}

function stateLabel(state: string): string {
  const words = state.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function entryTime(value: string, now: Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const time = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  return date.toDateString() === now.toDateString()
    ? `Today, ${time}`
    : `${date.toLocaleDateString()}, ${time}`;
}

function relativeTime(value: string, now: Date): string {
  const seconds = Math.round(
    (new Date(value).getTime() - now.getTime()) / 1000,
  );
  if (Number.isNaN(seconds)) return value;
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const steps: readonly [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.35],
    ['month', 12],
  ];
  let amount = seconds;
  for (const [unit, size] of steps) {
    if (Math.abs(amount) < size) return format.format(Math.round(amount), unit);
    amount /= size;
  }
  return format.format(Math.round(amount), 'year');
}

function mergeEvents(
  shown: readonly DeliveryEvent[],
  latest: readonly DeliveryEvent[],
): readonly DeliveryEvent[] {
  const known = new Set(shown.map((event) => event.id));
  const added = latest.filter((event) => !known.has(event.id));
  return added.length === 0 ? shown : [...shown, ...added];
}

const linkClass =
  'font-bold break-words underline outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]';

type Read =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | {
      readonly kind: 'shown';
      readonly page: DeliveryActivityPage;
      readonly events: readonly DeliveryEvent[];
      readonly earlierCursor: string | null;
    };

/**
 * The delivery story on a work item's Overview: what the builder has done, oldest first, and
 * what happens now, beside an at-a-glance summary.
 */
export function DeliveryActivity({
  client = browserDeliveryActivityClient,
  intervalMs = 10_000,
  itemId,
  state,
}: {
  readonly client?: DeliveryActivityClient;
  readonly intervalMs?: number;
  readonly itemId: string;
  readonly state: string;
}): ReactNode {
  const [read, setRead] = useState<Read>({ kind: 'loading' });
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const restored = useRef(false);
  const now = new Date();

  const load = useCallback(
    /** A quiet read keeps what is shown: a poll, or a retry that must keep the button focused. */
    async (quiet: boolean) => {
      if (!quiet) setRead({ kind: 'loading' });
      try {
        const page = await client.read(itemId);
        setRead((current) =>
          current.kind === 'shown'
            ? {
                ...current,
                events: mergeEvents(current.events, page.events),
                page,
              }
            : {
                earlierCursor: page.earlierCursor,
                events: page.events,
                kind: 'shown',
                page,
              },
        );
      } catch {
        // Old activity must never look current, so a failed poll shows the failure too.
        setRead({ kind: 'failed' });
      }
    },
    [client, itemId],
  );

  useEffect(() => {
    void load(false);
    const timer = window.setInterval(() => void load(true), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, load]);

  const shown = read.kind === 'shown';
  useEffect(() => {
    if (!shown || restored.current) return;
    restored.current = true;
    const focus = rememberedDeliveryFocus();
    if (focus === null || focus.itemId !== itemId) return;
    writeFocus(null);
    document.getElementById(focus.linkId)?.focus();
  }, [itemId, shown]);

  const showEarlier = async () => {
    if (read.kind !== 'shown' || read.earlierCursor === null) return;
    setLoadingEarlier(true);
    try {
      const earlier = await client.read(itemId, read.earlierCursor);
      setRead((current) => {
        if (current.kind !== 'shown') return current;
        const known = new Set(current.events.map((event) => event.id));
        return {
          ...current,
          earlierCursor: earlier.earlierCursor,
          events: [
            ...earlier.events.filter((event) => !known.has(event.id)),
            ...current.events,
          ],
        };
      });
    } catch {
      // The button stays, so the navigator can try again.
    } finally {
      setLoadingEarlier(false);
    }
  };

  const remember = (linkId: string) => writeFocus({ itemId, linkId });

  const glance = read.kind === 'shown' ? read.page : null;

  return (
    <div className="@container mt-6 border-t border-[var(--border)] pt-5">
      <div className="grid gap-4 @xl:grid-cols-[minmax(0,1fr)_minmax(0,14rem)]">
        <section
          aria-labelledby="delivery-activity-heading"
          className="min-w-0 rounded-lg border border-[var(--border)] p-4"
        >
          <h3 className="font-bold" id="delivery-activity-heading">
            Delivery activity
          </h3>
          {read.kind === 'loading' ? (
            <p
              aria-busy="true"
              className="mt-3 animate-pulse text-sm text-[var(--muted)] motion-reduce:animate-none"
            >
              Loading delivery activity…
            </p>
          ) : read.kind === 'failed' ? (
            <div className="mt-3" role="alert">
              <p className="font-bold">Delivery activity couldn’t be loaded.</p>
              <p className="mt-1 text-sm text-[var(--muted)]">
                Try again to see the latest delivery activity.
              </p>
              <button
                className="secondary-button mt-3"
                onClick={() => void load(true)}
                type="button"
              >
                Try again
              </button>
            </div>
          ) : (
            <>
              {read.earlierCursor === null ? null : (
                <button
                  className="mt-3 text-sm font-bold underline outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
                  disabled={loadingEarlier}
                  onClick={() => void showEarlier()}
                  type="button"
                >
                  Show earlier activity
                </button>
              )}
              {read.events.length === 0 && read.page.current === null ? (
                <p className="mt-3 text-sm text-[var(--muted)]">
                  No delivery activity yet. A builder will start when one is
                  available.
                </p>
              ) : (
                <ol className="mt-3 grid gap-3">
                  {read.events.map((event) => (
                    <Entry
                      at={entryTime(event.at, now)}
                      key={event.id}
                      tone={
                        event.kind === 'checks' && !event.passed
                          ? 'failed'
                          : 'done'
                      }
                    >
                      <EventText event={event} onFollow={remember} />
                    </Entry>
                  ))}
                  {read.page.current === null ? null : (
                    <Entry at="Now" tone="current">
                      <CurrentText
                        current={read.page.current}
                        onFollow={remember}
                      />
                    </Entry>
                  )}
                </ol>
              )}
            </>
          )}
        </section>
        <aside
          aria-labelledby="delivery-glance-heading"
          className="min-w-0 rounded-lg border border-[var(--border)] p-4"
        >
          <h3 className="font-bold" id="delivery-glance-heading">
            At a glance
          </h3>
          <p className="mt-2 inline-block rounded-full bg-[var(--accent-muted)] px-3 py-1 text-sm font-bold">
            {stateLabel(state)}
          </p>
          <dl className="mt-3 grid gap-2 text-sm">
            <div>
              <dt className="text-[var(--muted)]">Current step</dt>
              <dd className="font-bold">{currentSteps[state] ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-[var(--muted)]">Pull request</dt>
              <dd className="font-bold break-words">
                {glance?.latestPullRequest ? (
                  <a
                    className={linkClass}
                    href={glance.latestPullRequest.url}
                    id="delivery-glance-pull-request"
                    onClick={() => remember('delivery-glance-pull-request')}
                  >
                    #{glance.latestPullRequest.number}
                  </a>
                ) : (
                  'None yet'
                )}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--muted)]">Latest check</dt>
              <dd className="font-bold">
                {glance?.latestChecks
                  ? `${glance.latestChecks.passed ? 'Passed' : 'Failed'} ${relativeTime(glance.latestChecks.at, now)}`
                  : 'None yet'}
              </dd>
            </div>
          </dl>
        </aside>
      </div>
    </div>
  );
}

function Entry({
  at,
  children,
  tone,
}: {
  readonly at: string;
  readonly children: ReactNode;
  readonly tone: 'current' | 'done' | 'failed';
}): ReactNode {
  const dot =
    tone === 'failed'
      ? 'bg-[var(--danger)]'
      : tone === 'current'
        ? 'bg-[var(--accent)] ring-4 ring-[var(--accent-muted)]'
        : 'bg-[var(--muted)]';
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3">
      <span
        aria-hidden="true"
        className={`mt-1.5 size-2.5 rounded-full ${dot}`}
      />
      <div className="min-w-0 break-words">
        {children}
        <p className="mt-0.5 text-xs text-[var(--muted)]">{at}</p>
      </div>
    </li>
  );
}

function EventText({
  event,
  onFollow,
}: {
  readonly event: DeliveryEvent;
  readonly onFollow: (linkId: string) => void;
}): ReactNode {
  const linkId = `delivery-link-${event.id}`;
  switch (event.kind) {
    case 'plan':
      return (
        <>
          <h4 className="font-bold">
            {event.runId === null ? (
              'Plan recorded'
            ) : (
              <a
                className={linkClass}
                href={`#/conversations/${event.runId}`}
                id={linkId}
                onClick={() => onFollow(linkId)}
              >
                Plan recorded
              </a>
            )}
          </h4>
          <p className="text-sm text-[var(--muted)]">
            {event.agentName ?? 'The builder'} set out how this change will be
            built and checked.
          </p>
        </>
      );
    case 'checks':
      return event.passed ? (
        <>
          <h4 className="font-bold">Checks passed</h4>
          <p className="text-sm text-[var(--muted)]">
            All required checks finished successfully.
          </p>
        </>
      ) : (
        <>
          <h4 className="font-bold text-[var(--danger)]">Checks failed.</h4>
          <p className="text-sm text-[var(--muted)]">
            The builder will correct them before the pull request opens.
          </p>
        </>
      );
    case 'pull_request':
      return (
        <>
          <h4 className="font-bold">Pull request opened</h4>
          <p className="text-sm">
            <a
              className={linkClass}
              href={event.url}
              id={linkId}
              onClick={() => onFollow(linkId)}
            >
              #{event.number}
              {event.title === null ? '' : ` ${event.title}`}
            </a>
          </p>
        </>
      );
  }
}

function CurrentText({
  current,
  onFollow,
}: {
  readonly current: NonNullable<DeliveryCurrent>;
  readonly onFollow: (linkId: string) => void;
}): ReactNode {
  if (current.kind === 'plan_approval') {
    return (
      <>
        <h4 className="font-bold">Plan approval needed.</h4>
        <button
          className="primary-button mt-2"
          id="delivery-review-plan"
          onClick={() => {
            onFollow('delivery-review-plan');
            window.location.hash = `#/conversations/${current.runId}`;
          }}
          type="button"
        >
          Review plan
        </button>
      </>
    );
  }
  return (
    <>
      <h4 className="font-bold">Waiting for review</h4>
      <p className="text-sm text-[var(--muted)]">
        {current.reviewer ?? 'The reviewer'} will review the pull request next.
        Nothing is needed from you.
      </p>
    </>
  );
}
