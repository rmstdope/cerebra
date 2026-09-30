import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';

import { trapFocus } from './focus-trap';

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
  | {
      readonly kind: 'review';
      readonly findings: readonly ReviewFinding[];
      readonly revision: string;
      readonly url: string | null;
      readonly verdict: 'approved' | 'changes_requested';
    }
  | {
      readonly kind: 'rework_started';
      readonly maxRounds: number;
      readonly round: number;
    }
  | ({ readonly kind: 'blocked' } & BlockedDetail)
  | { readonly kind: 'sent_back' }
  | { readonly kind: 'returned_to_design'; readonly reason: string }
  | { readonly kind: 'merged'; readonly base: string; readonly sha: string }
  | {
      readonly kind: 'navigator_review';
      readonly body: string;
      readonly comments: readonly NavigatorReviewComment[];
      readonly url: string | null;
      readonly verdict: 'approved' | 'changes_requested';
    }
  | {
      readonly kind: 'review_not_counted';
      readonly account: string;
      readonly login: string;
    }
);

/** A comment on the navigator's own GitHub review. */
export interface NavigatorReviewComment {
  readonly body: string;
  readonly file: string;
  readonly line?: number;
}

export interface ReviewFinding {
  readonly file: string;
  readonly line?: number;
  readonly problem: string;
  readonly severity: 'advisory' | 'blocking';
}

export type BlockedReason =
  | 'changed_since_approval'
  | 'check_failed'
  | 'conflict'
  | 'refused'
  | 'too_many_attempts'
  | 'too_many_rounds';

export interface BlockedDetail {
  readonly base?: string;
  readonly check?: string;
  readonly count?: number;
  readonly message?: string;
  readonly reason: BlockedReason;
  readonly revision?: string;
  readonly reviewer?: string;
}

type BlockedEvent = Extract<DeliveryEvent, { kind: 'blocked' }>;

/** The item is waiting on the navigator because of this block. */
export interface DeliveryBlocked {
  readonly canReturnToDesign: boolean;
  readonly event: BlockedEvent;
}

type ChecksEvent = Extract<DeliveryEvent, { kind: 'checks' }>;
type PullRequestEvent = Extract<DeliveryEvent, { kind: 'pull_request' }>;

export type DeliveryCurrent =
  | { readonly kind: 'waiting_for_review'; readonly reviewer: string | null }
  | { readonly kind: 'plan_approval'; readonly runId: string }
  | { readonly kind: 'waiting_for_checks' }
  | {
      /** The GitHub account whose review counts. */
      readonly account: string;
      readonly kind: 'code_review';
      readonly pullRequestUrl: string | null;
      /** The agent that approved it. */
      readonly reviewer: string | null;
    }
  | null;

export interface DeliveryActivityPage {
  readonly blocked?: DeliveryBlocked | null;
  readonly current: DeliveryCurrent;
  readonly earlierCursor: string | null;
  readonly events: readonly DeliveryEvent[];
  readonly latestChecks: ChecksEvent | null;
  readonly latestPullRequest: PullRequestEvent | null;
}

export interface DeliveryActivityClient {
  read(itemId: string, before?: string): Promise<DeliveryActivityPage>;
  /** Answers a block by giving the item back to a builder; resolves with the moved item. */
  sendBack?(itemId: string): Promise<unknown>;
  /** Answers a block by sending the item back to design, closing its pull request. */
  returnToDesign?(itemId: string, reason: string): Promise<unknown>;
}

async function answer(path: string, body?: object): Promise<unknown> {
  const response = await fetch(path, {
    body: JSON.stringify(body ?? {}),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  if (!response.ok) throw new Error(`Answer failed (${response.status})`);
  return (await response.json()) as unknown;
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
  returnToDesign: (itemId, reason) =>
    answer(`/api/work-items/${encodeURIComponent(itemId)}/return-to-design`, {
      reason,
    }),
  sendBack: (itemId) =>
    answer(`/api/work-items/${encodeURIComponent(itemId)}/send-back`),
};

/** The heading a person sees for a block, in the banner, the trail and the queue. */
export function blockedHeading(detail: BlockedDetail): string {
  switch (detail.reason) {
    case 'changed_since_approval':
      return "Can't merge: changed since approval";
    case 'check_failed':
      return "Can't merge: a required check failed";
    case 'conflict':
      return `Can't merge: the branch conflicts with ${detail.base ?? 'main'}`;
    case 'refused':
      return "Can't merge: GitHub refused the merge";
    case 'too_many_attempts':
      return 'Stopped: too many attempts';
    case 'too_many_rounds':
      return "Can't merge: too many rounds";
  }
}

function shortRevision(revision: string | undefined): string {
  return (revision ?? '').slice(0, 7);
}

/** The one sentence that explains a block. */
export function blockedSentence(detail: BlockedDetail): string {
  const reviewer = detail.reviewer ?? 'The reviewer';
  const revision = shortRevision(detail.revision);
  switch (detail.reason) {
    case 'changed_since_approval':
      return `New changes arrived after ${reviewer} approved revision ${revision}. They haven't been reviewed.`;
    case 'check_failed':
      return `“${detail.check ?? 'A required check'}” failed on revision ${revision}. ${reviewer} approved it, but nothing merges red.`;
    case 'conflict':
      return `The pull request can't be merged cleanly into ${detail.base ?? 'main'}.`;
    case 'refused':
      return detail.message ?? 'GitHub gave no reason.';
    case 'too_many_attempts':
      return `${detail.count ?? 0} builder runs ended without finishing this.`;
    case 'too_many_rounds':
      return `This has gone back to the builder ${detail.count ?? 0} times without being approved.`;
  }
}

/** The states whose Overview tells a delivery story. */
export const deliveryStates: ReadonlySet<string> = new Set([
  'build_ready',
  'building',
  'design_ready',
  'review_ready',
  'reviewing',
  'merging',
  'waiting',
  'done',
]);

const currentSteps: Readonly<Record<string, string>> = {
  build_ready: 'Waiting for a builder',
  building: 'Building',
  design_ready: 'Back in design',
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
 * The delivery story on a work item's Overview: what the builder and reviewer have done, oldest
 * first, and what happens now, beside an at-a-glance summary. A block the navigator must answer
 * shows as a banner above `lead`, the rest of the Overview's opening.
 */
export function DeliveryActivity({
  client = browserDeliveryActivityClient,
  intervalMs = 10_000,
  itemId,
  lead = null,
  onAnswered,
  state,
}: {
  readonly client?: DeliveryActivityClient;
  readonly intervalMs?: number;
  readonly itemId: string;
  readonly lead?: ReactNode;
  /** Told the moved item once the navigator's answer to a block has saved. */
  readonly onAnswered?: (item: unknown) => void;
  readonly state: string;
}): ReactNode {
  const [read, setRead] = useState<Read>({ kind: 'loading' });
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [answering, setAnswering] = useState<Answering>(null);
  const [answerFailed, setAnswerFailed] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [focusNew, setFocusNew] = useState<FocusNew | null>(null);
  const returnButton = useRef<HTMLButtonElement>(null);
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

  // After an answer, focus follows the entry it appended, once the trail shows it.
  useEffect(() => {
    if (focusNew === null || read.kind !== 'shown') return;
    const added = read.events.find(
      (event) => event.kind === focusNew.kind && !focusNew.known.has(event.id),
    );
    if (added === undefined) return;
    setFocusNew(null);
    document.getElementById(entryId(added.id))?.focus();
  }, [focusNew, read]);

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
  const blocked = read.kind === 'shown' ? (read.page.blocked ?? null) : null;

  /** Saves an answer; on success the banner goes and focus moves to the entry it appended. */
  const settle = async (
    kind: FocusNew['kind'],
    save: () => Promise<unknown>,
  ): Promise<boolean> => {
    const known = new Set(
      read.kind === 'shown' ? read.events.map((event) => event.id) : [],
    );
    setAnswering(kind);
    try {
      const item = await save();
      setFocusNew({ kind, known });
      onAnswered?.(item);
      await load(true);
      return true;
    } catch {
      return false;
    } finally {
      setAnswering(null);
    }
  };

  const sendBack = async () => {
    if (answering !== null) return;
    setAnswerFailed(false);
    const saved = await settle('sent_back', async () => {
      if (client.sendBack === undefined) throw new Error('No way to answer');
      return client.sendBack(itemId);
    });
    if (!saved) setAnswerFailed(true);
  };

  const closeDialog = () => {
    setDialog(null);
    // The button is back once the dialog is gone; focus waits for that render.
    window.setTimeout(() => returnButton.current?.focus());
  };

  const submitReturn = async (event: FormEvent) => {
    event.preventDefault();
    if (dialog === null || answering !== null) return;
    const reason = dialog.reason.trim();
    if (reason === '') {
      setDialog({ ...dialog, problem: 'empty' });
      document.getElementById('return-to-design-reason')?.focus();
      return;
    }
    setDialog({ ...dialog, problem: null });
    const saved = await settle('returned_to_design', async () => {
      if (client.returnToDesign === undefined) {
        throw new Error('No way to answer');
      }
      return client.returnToDesign(itemId, reason);
    });
    if (saved) {
      setDialog(null);
    } else {
      setDialog((current) =>
        current === null ? current : { ...current, problem: 'failed' },
      );
    }
  };

  // Design has no delivery story of its own; it shows one only for an item that came back.
  const quiet =
    state === 'design_ready' &&
    (read.kind === 'loading' ||
      (read.kind === 'shown' &&
        read.events.length === 0 &&
        read.page.current === null));

  return (
    <>
      {blocked === null ? null : (
        <Banner
          answering={answering}
          blocked={blocked}
          failed={answerFailed}
          onReturn={() => {
            if (answering !== null) return;
            setAnswerFailed(false);
            setDialog({ problem: null, reason: '' });
          }}
          onSendBack={() => void sendBack()}
          pullRequestUrl={glance?.latestPullRequest?.url ?? null}
          returnButton={returnButton}
        />
      )}
      {glance?.current?.kind === 'code_review' ? (
        <CodeReviewBanner
          current={glance.current}
          onFollow={remember}
          pullRequestUrl={glance.latestPullRequest?.url ?? null}
        />
      ) : null}
      {lead}
      {quiet ? null : (
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
                  <p className="font-bold">
                    Delivery activity couldn’t be loaded.
                  </p>
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
                          id={entryId(event.id)}
                          key={event.id}
                          tone={eventTone(event)}
                        >
                          <EventText
                            event={event}
                            onFollow={remember}
                            waiting={blocked?.event.id === event.id}
                          />
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
      )}
      {dialog === null ? null : (
        <ReturnDialog
          dialog={dialog}
          onCancel={closeDialog}
          onReason={(reason) => setDialog({ ...dialog, reason })}
          onSubmit={(event) => void submitReturn(event)}
          saving={answering === 'returned_to_design'}
        />
      )}
    </>
  );
}

type Answering = 'returned_to_design' | 'sent_back' | null;

interface DialogState {
  readonly problem: 'empty' | 'failed' | null;
  readonly reason: string;
}

interface FocusNew {
  readonly kind: 'returned_to_design' | 'sent_back';
  readonly known: ReadonlySet<string>;
}

function entryId(eventId: string): string {
  return `delivery-entry-${eventId}`;
}

type Tone = 'current' | 'done' | 'failed' | 'success';

function eventTone(event: DeliveryEvent): Tone {
  switch (event.kind) {
    case 'checks':
      return event.passed ? 'done' : 'failed';
    case 'review':
      return event.verdict === 'approved' ? 'success' : 'failed';
    case 'blocked':
      return 'failed';
    case 'merged':
      return 'success';
    case 'navigator_review':
      return event.verdict === 'approved' ? 'success' : 'failed';
    default:
      return 'done';
  }
}

const answerFailure = "That didn't go through. Try again.";

function Banner({
  answering,
  blocked,
  failed,
  onReturn,
  onSendBack,
  pullRequestUrl,
  returnButton,
}: {
  readonly answering: Answering;
  readonly blocked: DeliveryBlocked;
  readonly failed: boolean;
  readonly onReturn: () => void;
  readonly onSendBack: () => void;
  readonly pullRequestUrl: string | null;
  readonly returnButton: RefObject<HTMLButtonElement | null>;
}): ReactNode {
  return (
    <section
      aria-labelledby="delivery-blocked-heading"
      className="mb-5 rounded-lg border border-[var(--danger)] bg-red-50 p-4 dark:bg-red-950"
    >
      <h3
        className="font-bold text-[var(--danger)]"
        id="delivery-blocked-heading"
      >
        {blockedHeading(blocked.event)}
      </h3>
      <p className="mt-1 text-sm">{blockedSentence(blocked.event)}</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        <button
          className="primary-button w-full sm:w-auto"
          aria-disabled={answering !== null}
          onClick={onSendBack}
          type="button"
        >
          Send back to the builder
        </button>
        {blocked.canReturnToDesign ? (
          <button
            className="secondary-button w-full sm:w-auto"
            aria-disabled={answering !== null}
            onClick={onReturn}
            ref={returnButton}
            type="button"
          >
            Return to design…
          </button>
        ) : null}
        {pullRequestUrl === null ? null : (
          <a className={linkClass} href={pullRequestUrl}>
            Open the pull request
          </a>
        )}
      </div>
      {failed ? (
        <p className="mt-3 text-sm font-bold text-[var(--danger)]" role="alert">
          {answerFailure}
        </p>
      ) : null}
    </section>
  );
}

/** The item waits for the navigator's own review on GitHub (spec §4.9). */
function CodeReviewBanner({
  current,
  onFollow,
  pullRequestUrl,
}: {
  readonly current: Extract<DeliveryCurrent, { kind: 'code_review' }>;
  readonly onFollow: (linkId: string) => void;
  readonly pullRequestUrl: string | null;
}): ReactNode {
  const url = current.pullRequestUrl ?? pullRequestUrl;
  return (
    <section
      aria-labelledby="delivery-code-review-heading"
      className="mb-5 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-50"
    >
      <h3 className="font-bold" id="delivery-code-review-heading">
        Waiting for your review on GitHub
      </h3>
      <p className="mt-1 text-sm">
        {current.reviewer ?? 'The reviewer'} approved it. It merges once you
        approve the pull request as {current.account}; requested changes send it
        back to the builder.
      </p>
      {url === null ? null : (
        <a
          className="primary-button mt-3 inline-block w-full text-center sm:w-auto"
          href={url}
          id="delivery-code-review-open"
          onClick={() => onFollow('delivery-code-review-open')}
        >
          Review on GitHub
        </a>
      )}
    </section>
  );
}

function ReturnDialog({
  dialog,
  onCancel,
  onReason,
  onSubmit,
  saving,
}: {
  readonly dialog: DialogState;
  readonly onCancel: () => void;
  readonly onReason: (reason: string) => void;
  readonly onSubmit: (event: FormEvent) => void;
  readonly saving: boolean;
}): ReactNode {
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => field.current?.focus(), []);
  return (
    <div
      aria-labelledby="return-to-design-title"
      aria-modal="true"
      className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4"
      onKeyDown={(event) => trapFocus(event, onCancel)}
      role="dialog"
    >
      <form className="card w-full max-w-md" noValidate onSubmit={onSubmit}>
        <h2 className="font-bold" id="return-to-design-title">
          Return to design?
        </h2>
        <p className="mt-2 text-sm text-[var(--muted)]">
          The pull request will be closed with your reason, and the next build
          starts a new one.
        </p>
        <label className="auth-label" htmlFor="return-to-design-reason">
          Why is it going back?
        </label>
        <textarea
          aria-describedby={
            dialog.problem === 'empty' ? 'return-to-design-problem' : undefined
          }
          aria-invalid={dialog.problem === 'empty'}
          className="auth-input min-h-24"
          id="return-to-design-reason"
          onChange={(event) => onReason(event.target.value)}
          ref={field}
          required
          value={dialog.reason}
        />
        {dialog.problem === 'empty' ? (
          <p
            className="mt-2 text-sm text-[var(--danger)]"
            id="return-to-design-problem"
          >
            Give a reason so the designer and the next builder know what to
            change.
          </p>
        ) : null}
        {dialog.problem === 'failed' ? (
          <p
            className="mt-4 text-sm font-bold text-[var(--danger)]"
            role="alert"
          >
            {answerFailure}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap justify-end gap-3">
          <button className="secondary-button" onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            aria-disabled={saving}
            className="primary-button"
            type="submit"
          >
            Return to design
          </button>
        </div>
      </form>
    </div>
  );
}

function Entry({
  at,
  children,
  id,
  tone,
}: {
  readonly at: string;
  readonly children: ReactNode;
  readonly id?: string;
  readonly tone: Tone;
}): ReactNode {
  const dot =
    tone === 'failed'
      ? 'bg-[var(--danger)]'
      : tone === 'success'
        ? 'bg-[var(--success)]'
        : tone === 'current'
          ? 'bg-[var(--accent)] ring-4 ring-[var(--accent-muted)]'
          : 'bg-[var(--muted)]';
  return (
    <li
      className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 rounded outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
      id={id}
      tabIndex={id === undefined ? undefined : -1}
    >
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

const shownFindings = 5;

function Findings({
  eventId,
  findings,
}: {
  readonly eventId: string;
  readonly findings: readonly ReviewFinding[];
}): ReactNode {
  const [all, setAll] = useState(false);
  const firstNew = useRef<HTMLLIElement>(null);
  const expanded = useRef(false);
  useEffect(() => {
    if (!all || expanded.current) return;
    expanded.current = true;
    firstNew.current?.focus({ preventScroll: true });
  }, [all]);
  if (findings.length === 0) return null;
  const ordered = [
    ...findings.filter((finding) => finding.severity === 'blocking'),
    ...findings.filter((finding) => finding.severity !== 'blocking'),
  ];
  const visible = all ? ordered : ordered.slice(0, shownFindings);
  return (
    <>
      <ul
        aria-label="Findings"
        className="mt-1 grid gap-1 text-sm"
        id={`delivery-findings-${eventId}`}
      >
        {visible.map((finding, index) => (
          <li
            className="rounded break-words outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
            // Findings carry no id of their own; their order is fixed for an entry.
            key={index}
            ref={index === shownFindings ? firstNew : undefined}
            tabIndex={index === shownFindings ? -1 : undefined}
          >
            <span
              className={`mr-1.5 rounded px-1.5 py-0.5 text-xs font-bold ${finding.severity === 'blocking' ? 'bg-red-50 text-[var(--danger)] dark:bg-red-950' : 'bg-[var(--accent-muted)]'}`}
            >
              {finding.severity === 'blocking' ? 'Blocking' : 'Advisory'}
            </span>
            <span className="font-mono text-xs">
              {finding.file}
              {finding.line === undefined ? '' : `:${finding.line}`}
            </span>{' '}
            — {finding.problem}
          </li>
        ))}
      </ul>
      {all || ordered.length <= shownFindings ? null : (
        <button
          aria-controls={`delivery-findings-${eventId}`}
          className="mt-1 text-sm font-bold underline outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
          onClick={() => setAll(true)}
          type="button"
        >
          Show all {ordered.length} findings
        </button>
      )}
    </>
  );
}

function EventText({
  event,
  onFollow,
  waiting,
}: {
  readonly event: DeliveryEvent;
  readonly onFollow: (linkId: string) => void;
  readonly waiting: boolean;
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
    case 'review': {
      const reviewer = event.agentName ?? 'The reviewer';
      const revision = shortRevision(event.revision);
      return (
        <>
          <h4 className="font-bold">
            {event.verdict === 'approved' ? 'Approved' : 'Changes requested'}
          </h4>
          <p className="text-sm text-[var(--muted)]">
            {event.verdict === 'approved'
              ? `${reviewer} approved revision ${revision}.`
              : `${reviewer}'s review of revision ${revision}:`}
          </p>
          <Findings eventId={event.id} findings={event.findings} />
          {event.url === null ? null : (
            <p className="mt-1 text-sm">
              <a
                className={linkClass}
                href={event.url}
                id={linkId}
                onClick={() => onFollow(linkId)}
              >
                Open the review on GitHub
              </a>
            </p>
          )}
        </>
      );
    }
    case 'rework_started':
      return (
        <>
          <h4 className="font-bold">Rework started</h4>
          <p className="text-sm text-[var(--muted)]">
            {event.agentName ?? 'The builder'} is correcting the same pull
            request. Round {event.round} of {event.maxRounds}.
          </p>
        </>
      );
    case 'blocked':
      return (
        <>
          <h4 className="font-bold text-[var(--danger)]">
            {blockedHeading(event)}
          </h4>
          <p className="text-sm text-[var(--muted)]">
            {waiting ? 'Waiting for you.' : blockedSentence(event)}
          </p>
        </>
      );
    case 'sent_back':
      return <h4 className="font-bold">Sent back to the builder</h4>;
    case 'returned_to_design':
      return (
        <>
          <h4 className="font-bold">Returned to design</h4>
          <p className="text-sm text-[var(--muted)]">
            “{event.reason}” The pull request was closed.
          </p>
        </>
      );
    case 'navigator_review':
      return (
        <>
          <h4
            className={`font-bold ${event.verdict === 'approved' ? '' : 'text-[var(--danger)]'}`}
          >
            {event.verdict === 'approved'
              ? 'You approved on GitHub'
              : 'You requested changes on GitHub'}
          </h4>
          {event.verdict === 'approved' ? (
            <p className="text-sm text-[var(--muted)]">
              Waiting for checks, then it merges.
            </p>
          ) : (
            <>
              {event.body.trim() === '' ? null : (
                <p className="text-sm break-words whitespace-pre-wrap">
                  “{event.body.trim()}”
                </p>
              )}
              {event.comments.length === 0 ? null : (
                <ul aria-label="Comments" className="mt-1 grid gap-1 text-sm">
                  {event.comments.map((comment, index) => (
                    // Comments carry no id of their own; their order is fixed for an entry.
                    <li className="break-words" key={index}>
                      <span className="font-mono text-xs">
                        {comment.file}
                        {comment.line === undefined ? '' : `:${comment.line}`}
                      </span>{' '}
                      — {comment.body}
                    </li>
                  ))}
                </ul>
              )}
              {event.url === null ? null : (
                <p className="mt-1 text-sm">
                  <a
                    className={linkClass}
                    href={event.url}
                    id={linkId}
                    onClick={() => onFollow(linkId)}
                  >
                    Open the review on GitHub
                  </a>
                </p>
              )}
            </>
          )}
        </>
      );
    case 'review_not_counted':
      return (
        <>
          <h4 className="font-bold">A review that doesn’t count</h4>
          <p className="text-sm text-[var(--muted)]">
            {event.login} approved on GitHub, but only {event.account}’s review
            counts here.
          </p>
        </>
      );
    case 'merged':
      return (
        <>
          <h4 className="font-bold">Merged</h4>
          <p className="text-sm text-[var(--muted)]">
            Merged into {event.base} and the branch was deleted.
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
  if (current.kind === 'code_review') {
    return (
      <>
        <h4 className="font-bold">Waiting for your review on GitHub</h4>
        <p className="text-sm text-[var(--muted)]">Waiting for you.</p>
      </>
    );
  }
  if (current.kind === 'waiting_for_checks') {
    return (
      <>
        <h4 className="font-bold">Waiting for checks</h4>
        <p className="text-sm text-[var(--muted)]">
          It merges automatically once every required check passes.
        </p>
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
