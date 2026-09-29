import { ProjectCostCard, WorkItemCost } from './cost-summary';
import { browserCostClient, type CostClient } from './costs';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

import {
  BoardRequestError,
  browserBoardClient,
  typeLabel,
  workItemStates,
  workItemTypes,
  type BoardClient,
  type BoardComment,
  type BoardFilters,
  type BoardRoute,
  type FiledBy,
  type HistoryEntry,
  type Priority,
  type WorkItem,
  type WorkItemType,
} from './board';
import {
  browserDeliveryActivityClient,
  DeliveryActivity,
  deliveryStates,
  rememberedDeliveryFocus,
  type DeliveryActivityClient,
} from './delivery-activity';
import {
  browserAutomaticStartsClient,
  reasonText,
  type AutomaticStartStatus,
  type AutomaticStartsClient,
  type WaitingReason,
} from './automatic-starts';

type BoardStorage = Pick<Storage, 'getItem' | 'setItem'>;
type Tab = 'overview' | 'discussion' | 'history';
type Panel =
  { kind: 'none' } | { kind: 'draft' } | { kind: 'item'; id: string };

interface Remote<T> {
  readonly data: T | null;
  readonly error: boolean;
  readonly loading: boolean;
}

interface ListState {
  readonly filters: BoardFilters;
  readonly items: readonly WorkItem[];
  readonly nextCursor: string | null;
  readonly snapshot: string;
  readonly total: number;
}

const emptyFilters: BoardFilters = {
  priority: '',
  search: '',
  sort: 'newest',
  state: '',
};

export const routes: readonly {
  readonly description: string;
  readonly label: string;
  readonly value: BoardRoute;
}[] = [
  {
    description:
      'Clarify the intended result before someone designs or builds it.',
    label: 'Groom the outcome',
    value: 'grooming_ready',
  },
  {
    description:
      'The intended result is already clear and needs an agreed experience.',
    label: 'Send to design',
    value: 'design_ready',
  },
  {
    description: 'It can be built without a design session.',
    label: 'Send to build',
    value: 'build_ready',
  },
];

const idle = { data: null, error: false, loading: false } as const;

export function stateLabel(state: string): string {
  if (state === 'new') return 'Needs triage';
  const words = state.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function actorLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function filtersKey(projectId: string): string {
  return `cerebra.board.${projectId}`;
}

const storedPriorities: readonly string[] = ['P0', 'P1', 'P2', 'P3', 'none'];

function readFilters(storage: BoardStorage, projectId: string): BoardFilters {
  try {
    const stored = JSON.parse(
      storage.getItem(filtersKey(projectId)) ?? 'null',
    ) as Partial<BoardFilters> | null;
    if (stored === null || typeof stored !== 'object') return emptyFilters;
    return {
      priority:
        typeof stored.priority === 'string' &&
        storedPriorities.includes(stored.priority)
          ? stored.priority
          : emptyFilters.priority,
      search: typeof stored.search === 'string' ? stored.search : '',
      sort:
        stored.sort === 'oldest' || stored.sort === 'priority'
          ? stored.sort
          : 'newest',
      state:
        typeof stored.state === 'string' &&
        (workItemStates as readonly string[]).includes(stored.state)
          ? stored.state
          : '',
    };
  } catch {
    return emptyFilters;
  }
}

function browserStorage(): BoardStorage {
  try {
    return window.localStorage;
  } catch {
    return { getItem: () => null, setItem: () => undefined };
  }
}

function isReady(state: string): boolean {
  return state.endsWith('_ready');
}

function FiledByLine({
  filedBy,
  id,
  onOpen,
}: {
  readonly filedBy: FiledBy | null;
  readonly id: string;
  readonly onOpen: (itemId: string) => void;
}) {
  const className = 'm-0 px-2 pb-1 text-sm break-words text-[var(--muted)]';
  if (filedBy === null) {
    return (
      <p className={className} id={id}>
        Filed by you
      </p>
    );
  }
  const who = `Filed by ${filedBy.agentName ?? 'an agent'}`;
  if (filedBy.role === 'assistant') {
    return (
      <p className={className} id={id}>
        {who} in a conversation with you
      </p>
    );
  }
  const from = filedBy.discoveredFrom;
  if (from === null) {
    return (
      <p className={className} id={id}>
        {who}
      </p>
    );
  }
  return (
    <p className={className} id={id}>
      {who} {filedBy.role === 'groomer' ? 'while grooming' : 'while working on'}{' '}
      <button
        className="rounded p-0 text-left text-[var(--accent)] underline outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
        onClick={() => onOpen(from.id)}
        type="button"
      >
        {from.title}
      </button>
    </p>
  );
}

function WaitingChip({
  error,
  id,
  onRetry,
  reason,
}: {
  readonly error: boolean;
  readonly id: string;
  readonly onRetry: () => void;
  readonly reason: WaitingReason | null;
}): ReactNode {
  const blocked = error || reason?.kind === 'credential_missing';
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs sm:ml-auto">
      <span
        className={`rounded-full px-2 py-1 font-bold ${
          blocked
            ? 'bg-red-50 text-[var(--danger)] dark:bg-red-950'
            : 'bg-amber-100 text-amber-950 dark:bg-amber-900 dark:text-amber-50'
        }`}
        id={id}
      >
        {error || reason === null
          ? "Couldn't check why this is waiting"
          : reasonText(reason)}
      </span>
      {error ? (
        <button
          aria-describedby={id}
          className="font-bold underline"
          onClick={onRetry}
          type="button"
        >
          Try again
        </button>
      ) : reason?.kind === 'credential_missing' ? (
        <a
          className="font-bold underline outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
          href="#/settings/credentials"
        >
          Fix in settings
        </a>
      ) : null}
    </span>
  );
}

function isFiltered(filters: BoardFilters): boolean {
  return (
    filters.search.trim() !== '' ||
    filters.state !== '' ||
    filters.priority !== ''
  );
}

export function ProjectBoard({
  arrivalsIntervalMs = 30_000,
  automaticStartsClient = browserAutomaticStartsClient,
  boardClient = browserBoardClient,
  deliveryClient = browserDeliveryActivityClient,
  deliveryIntervalMs = 10_000,
  costClient = browserCostClient,
  onClose,
  openRequest = null,
  projectId,
  statusIntervalMs = 10_000,
  storage: storageOverride,
}: {
  readonly arrivalsIntervalMs?: number;
  readonly automaticStartsClient?: AutomaticStartsClient;
  readonly boardClient?: BoardClient;
  readonly deliveryClient?: DeliveryActivityClient;
  readonly deliveryIntervalMs?: number;
  readonly costClient?: CostClient;
  /** Called when an open item or draft is closed, so a caller can return to where it came from. */
  readonly onClose?: () => void;
  /** Opens an item from elsewhere, such as the navigator queue; a new object reopens it. */
  readonly openRequest?: {
    readonly id: string;
    readonly tab: 'discussion' | 'overview';
  } | null;
  readonly projectId: string;
  readonly statusIntervalMs?: number;
  readonly storage?: BoardStorage;
}): ReactNode {
  const [storage] = useState<BoardStorage>(
    () => storageOverride ?? browserStorage(),
  );
  const [filters, setFilters] = useState<BoardFilters>(() =>
    readFilters(storage, projectId),
  );
  const [list, setList] = useState<ListState | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [arrivals, setArrivals] = useState(0);
  const [panel, setPanel] = useState<Panel>({ kind: 'none' });
  const [tab, setTab] = useState<Tab>('overview');
  const [itemRead, setItemRead] = useState<Remote<WorkItem>>(idle);
  const [comments, setComments] =
    useState<Remote<readonly BoardComment[]>>(idle);
  const [history, setHistory] = useState<Remote<readonly HistoryEntry[]>>(idle);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [workType, setWorkType] = useState<WorkItemType>('feature');
  const [comment, setComment] = useState('');
  const [priority, setPriority] = useState<Priority>('P2');
  const [route, setRoute] = useState<BoardRoute>('grooming_ready');
  const [saving, setSaving] = useState(false);
  const [saveRetry, setSaveRetry] = useState<(() => void) | null>(null);
  const [routeRefused, setRouteRefused] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [focusTarget, setFocusTarget] = useState<
    { kind: 'row'; id: string } | { kind: 'cancel' } | { kind: 'dialog' } | null
  >(null);
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const cancelControl = useRef<HTMLButtonElement>(null);
  const dialogHeading = useRef<HTMLHeadingElement>(null);
  const listRequest = useRef(0);
  const shownItem = useRef<string | null>(null);
  const boardHeading = useRef<HTMLHeadingElement>(null);
  const [startStatus, setStartStatus] = useState<AutomaticStartStatus | null>(
    null,
  );
  const [startStatusError, setStartStatusError] = useState(false);
  const [toggleError, setToggleError] = useState<'pause' | 'resume' | null>(
    null,
  );
  const [toggling, setToggling] = useState(false);
  const [toggleFocus, setToggleFocus] = useState<'pause' | 'resume' | null>(
    null,
  );
  const pauseButton = useRef<HTMLButtonElement>(null);
  const resumeButton = useRef<HTMLButtonElement>(null);
  const statusRequest = useRef(0);

  const loadStartStatus = useCallback(async () => {
    const request = ++statusRequest.current;
    try {
      const next = await automaticStartsClient.status(projectId);
      if (request !== statusRequest.current) return;
      setStartStatus(next);
      setStartStatusError(false);
    } catch {
      if (request !== statusRequest.current) return;
      setStartStatusError(true);
    }
  }, [automaticStartsClient, projectId]);

  useEffect(() => {
    void loadStartStatus();
    const timer = window.setInterval(
      () => void loadStartStatus(),
      statusIntervalMs,
    );
    return () => window.clearInterval(timer);
  }, [loadStartStatus, statusIntervalMs]);

  useEffect(() => {
    if (toggleFocus === null) return;
    (toggleFocus === 'resume' ? resumeButton : pauseButton).current?.focus();
    setToggleFocus(null);
  }, [toggleFocus]);

  const setPaused = async (paused: boolean) => {
    setToggling(true);
    try {
      await automaticStartsClient.setPaused(projectId, paused);
      // A read already on its way may predate the change; its answer is dropped.
      statusRequest.current += 1;
      setStartStatus((current) =>
        current === null ? current : { ...current, paused },
      );
      setToggleError(null);
      setToggleFocus(paused ? 'resume' : 'pause');
      void loadStartStatus();
    } catch {
      setToggleError(paused ? 'pause' : 'resume');
    } finally {
      setToggling(false);
    }
  };
  const waitingReasons = new Map(
    (startStatus?.waiting ?? []).map(({ itemId, reason }) => [itemId, reason]),
  );

  const loadList = useCallback(
    async (current: BoardFilters) => {
      const request = ++listRequest.current;
      setListLoading(true);
      setListError(false);
      try {
        const next = await boardClient.list(projectId, current);
        if (request !== listRequest.current) return;
        setList({ ...next, filters: current });
        setArrivals(0);
        setMoreError(false);
      } catch {
        if (request !== listRequest.current) return;
        setListError(true);
      } finally {
        if (request === listRequest.current) setListLoading(false);
      }
    },
    [boardClient, projectId],
  );

  useEffect(() => {
    try {
      storage.setItem(filtersKey(projectId), JSON.stringify(filters));
    } catch {
      // Remembering filters is best effort; the board still works without it.
    }
    const timer = window.setTimeout(() => void loadList(filters), 150);
    return () => window.clearTimeout(timer);
  }, [filters, loadList, projectId, storage]);

  const snapshot = list?.snapshot ?? null;
  const listedFilters = list?.filters ?? null;
  useEffect(() => {
    if (snapshot === null || listedFilters === null) return;
    const timer = window.setInterval(() => {
      boardClient
        .arrivals(projectId, listedFilters, snapshot)
        .then(setArrivals)
        .catch(() => undefined);
    }, arrivalsIntervalMs);
    return () => window.clearInterval(timer);
  }, [arrivalsIntervalMs, boardClient, listedFilters, projectId, snapshot]);

  useEffect(() => {
    if (focusTarget === null) return;
    if (focusTarget.kind === 'row') {
      // A row outside the loaded page or filter falls back to the heading.
      (rows.current.get(focusTarget.id) ?? boardHeading.current)?.focus();
    }
    if (focusTarget.kind === 'cancel') cancelControl.current?.focus();
    if (focusTarget.kind === 'dialog') dialogHeading.current?.focus();
    setFocusTarget(null);
  }, [focusTarget]);

  const selectedId = panel.kind === 'item' ? panel.id : null;
  const selected =
    itemRead.data?.id === selectedId && itemRead.data !== null
      ? itemRead.data
      : (list?.items.find((item) => item.id === selectedId) ?? null);

  const replaceItem = (item: WorkItem) => {
    setList((current) =>
      current === null
        ? current
        : {
            ...current,
            items: current.items.map((candidate) =>
              candidate.id === item.id ? item : candidate,
            ),
          },
    );
    setItemRead({ data: item, error: false, loading: false });
  };

  const readItem = async (id: string) => {
    setItemRead((current) => ({ ...current, error: false, loading: true }));
    try {
      const item = await boardClient.item(id);
      if (shownItem.current === id) replaceItem(item);
    } catch {
      if (shownItem.current !== id) return;
      setItemRead((current) => ({ ...current, error: true, loading: false }));
    }
  };

  const readComments = async (id: string) => {
    setComments((current) => ({ ...current, error: false, loading: true }));
    try {
      const data = await boardClient.comments(id);
      if (shownItem.current !== id) return;
      setComments({ data, error: false, loading: false });
    } catch {
      if (shownItem.current !== id) return;
      setComments((current) => ({ ...current, error: true, loading: false }));
    }
  };

  const readHistory = async (id: string) => {
    setHistory((current) => ({ ...current, error: false, loading: true }));
    try {
      const data = await boardClient.history(id);
      if (shownItem.current !== id) return;
      setHistory({ data, error: false, loading: false });
    } catch {
      if (shownItem.current !== id) return;
      setHistory((current) => ({ ...current, error: true, loading: false }));
    }
  };

  const resetDetail = () => {
    setTab('overview');
    setItemRead(idle);
    setComments(idle);
    setHistory(idle);
    setComment('');
    setPriority('P2');
    setRoute('grooming_ready');
    setSaveRetry(null);
    setRouteRefused(false);
    setConfirming(false);
  };

  const openItem = (id: string) => {
    resetDetail();
    setNotice(null);
    shownItem.current = id;
    setPanel({ kind: 'item', id });
    void readItem(id);
  };

  const openDraft = () => {
    resetDetail();
    setWorkType('feature');
    setNotice(null);
    shownItem.current = null;
    setPanel({ kind: 'draft' });
  };

  const closePanel = () => {
    const id = selectedId;
    resetDetail();
    shownItem.current = null;
    setPanel({ kind: 'none' });
    if (id !== null) setFocusTarget({ kind: 'row', id });
    onClose?.();
  };

  const chooseTab = (next: Tab) => {
    setTab(next);
    if (selectedId === null) return;
    if (next === 'discussion') void readComments(selectedId);
    if (next === 'history') void readHistory(selectedId);
  };

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    setSaveRetry(null);
    try {
      const item = await boardClient.create(projectId, {
        description,
        title: title.trim(),
        type: workType,
      });
      setTitle('');
      setDescription('');
      setWorkType('feature');
      resetDetail();
      shownItem.current = item.id;
      setPanel({ kind: 'item', id: item.id });
      setItemRead({ data: item, error: false, loading: false });
      setNotice('Work item added. It is ready for you to review.');
      await loadList(filters);
    } catch {
      setSaveRetry(() => () => void save());
    } finally {
      setSaving(false);
    }
  };

  const triage = async () => {
    if (selected === null) return;
    setSaving(true);
    setSaveRetry(null);
    setRouteRefused(false);
    setNotice(null);
    try {
      replaceItem(await boardClient.triage(selected.id, priority, route));
      setNotice('Priority and next step updated.');
    } catch (error) {
      if (
        error instanceof BoardRequestError &&
        error.code === 'route_unavailable'
      ) {
        setRouteRefused(true);
      } else {
        setSaveRetry(() => () => void triage());
      }
    } finally {
      setSaving(false);
    }
  };

  const cancel = async () => {
    if (selected === null) return;
    const id = selected.id;
    setSaving(true);
    setSaveRetry(null);
    try {
      replaceItem(await boardClient.cancel(id));
      if (shownItem.current !== id) return;
      // Closing the detail keeps the row reachable on a narrow window too.
      closePanel();
    } catch {
      setConfirming(false);
      setSaveRetry(() => () => void cancel());
    } finally {
      setSaving(false);
    }
  };

  const postComment = async () => {
    if (selectedId === null || !comment.trim()) return;
    setSaving(true);
    setSaveRetry(null);
    try {
      const id = selectedId;
      const added = await boardClient.addComment(id, comment.trim());
      if (shownItem.current !== id) return;
      setComments((current) => ({
        ...current,
        data: [...(current.data ?? []), added],
      }));
      setComment('');
    } catch {
      setSaveRetry(() => () => void postComment());
    } finally {
      setSaving(false);
    }
  };

  const loadMore = async () => {
    if (list === null || list.nextCursor === null) return;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const next = await boardClient.list(projectId, list.filters, {
        cursor: list.nextCursor,
        snapshot: list.snapshot,
      });
      setList((current) =>
        current === null
          ? { ...next, filters: list.filters }
          : {
              ...current,
              items: [...current.items, ...next.items],
              nextCursor: next.nextCursor,
            },
      );
    } catch {
      setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const closeDialog = () => {
    setConfirming(false);
    setFocusTarget({ kind: 'cancel' });
  };

  const panelOpen = panel.kind !== 'none';
  const escape = useRef<() => void>(() => undefined);
  escape.current = () => {
    if (confirming) closeDialog();
    else if (panelOpen) closePanel();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      escape.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openFromRequest = useRef<
    (request: NonNullable<typeof openRequest>) => void
  >(() => undefined);
  openFromRequest.current = (request) => {
    openItem(request.id);
    if (request.tab === 'discussion') {
      setTab('discussion');
      void readComments(request.id);
    }
    boardHeading.current?.focus();
  };
  useEffect(() => {
    if (openRequest !== null) openFromRequest.current(openRequest);
  }, [openRequest]);

  const reopenForFocus = useRef<() => void>(() => undefined);
  reopenForFocus.current = () => {
    const focus = rememberedDeliveryFocus();
    if (openRequest === null && focus !== null) openItem(focus.itemId);
  };
  // Back from a delivery link lands on a fresh board; reopen the item whose link was followed.
  useEffect(() => reopenForFocus.current(), []);

  const updateFilters = (change: Partial<BoardFilters>) =>
    setFilters((current) => ({ ...current, ...change }));

  return (
    <section aria-labelledby="project-board-heading" className="mt-10">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <h2
            className="text-3xl font-bold tracking-tight sm:text-4xl"
            id="project-board-heading"
            ref={boardHeading}
            tabIndex={-1}
          >
            Project board
          </h2>
          <p className="mt-1 text-[var(--muted)]">
            See what is waiting, in progress and finished.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
          {startStatus !== null && !startStatus.paused ? (
            <>
              <span className="text-sm text-[var(--muted)]">
                Starting work automatically · {startStatus.running} of{' '}
                {startStatus.limit} running
              </span>
              <button
                className="secondary-button"
                disabled={toggling}
                onClick={() => void setPaused(true)}
                ref={pauseButton}
                type="button"
              >
                Pause automatic starts
              </button>
            </>
          ) : null}
          <button className="primary-button" onClick={openDraft} type="button">
            Add work item
          </button>
        </div>
      </div>
      {toggleError !== null ? (
        <div
          className="auth-error flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
          role="alert"
        >
          <span>
            {toggleError === 'pause'
              ? "Cerebra couldn't pause automatic starts. Nothing has changed."
              : "Cerebra couldn't resume automatic starts. Nothing has changed."}
          </span>
          <button
            className="secondary-button"
            disabled={toggling}
            onClick={() => void setPaused(toggleError === 'pause')}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : null}
      {startStatus?.paused === true ? (
        <div className="mt-5 flex flex-col gap-3 rounded-lg border-l-4 border-amber-500 bg-amber-50 p-3 text-sm text-amber-950 sm:flex-row sm:items-center sm:justify-between dark:bg-amber-950 dark:text-amber-50">
          <p>
            <strong>Automatic starts are paused.</strong> Work already running
            continues, and you can still start anyone yourself from the fleet.
          </p>
          <button
            className="primary-button"
            disabled={toggling}
            onClick={() => void setPaused(false)}
            ref={resumeButton}
            type="button"
          >
            Resume
          </button>
        </div>
      ) : null}
      <div className="mt-6 flex flex-wrap gap-3">
        <input
          aria-label="Search work items"
          className="auth-input mt-0 min-w-0 flex-[2_1_14rem]"
          onChange={(event) => updateFilters({ search: event.target.value })}
          placeholder="Search work items"
          type="search"
          value={filters.search}
        />
        <select
          aria-label="Filter by state"
          className="auth-input mt-0 w-auto flex-[1_1_10rem]"
          onChange={(event) => updateFilters({ state: event.target.value })}
          value={filters.state}
        >
          <option value="">All states</option>
          {workItemStates.map((state) => (
            <option key={state} value={state}>
              {stateLabel(state)}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by priority"
          className="auth-input mt-0 w-auto flex-[1_1_10rem]"
          onChange={(event) => updateFilters({ priority: event.target.value })}
          value={filters.priority}
        >
          <option value="">All priorities</option>
          {['P0', 'P1', 'P2', 'P3'].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
          <option value="none">No priority</option>
        </select>
        <select
          aria-label="Sort work items"
          className="auth-input mt-0 w-auto flex-[1_1_12rem]"
          onChange={(event) =>
            updateFilters({ sort: event.target.value as BoardFilters['sort'] })
          }
          value={filters.sort}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="priority">Highest priority first</option>
        </select>
      </div>
      <p aria-live="polite" className="mt-4 empty:hidden" role="status">
        {notice}
      </p>
      <div className="mt-5 grid gap-5 lg:grid-cols-[1.4fr_.9fr]">
        <section
          aria-label="Work items"
          className={`card p-0 ${panelOpen ? 'hidden lg:block' : ''}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] p-5">
            <h2 className="text-lg font-bold">Work items</h2>
            <span className="text-sm text-[var(--muted)]">
              {list !== null && listLoading ? 'Loading… ' : ''}
              {list !== null
                ? `${list.total} ${list.total === 1 ? 'item' : 'items'}`
                : ''}
            </span>
          </div>
          {listError ? (
            <p className="auth-error m-5" role="alert">
              Cerebra couldn’t load this board. Try again.{' '}
              <button
                className="font-bold underline"
                onClick={() => void loadList(filters)}
                type="button"
              >
                Try again
              </button>
            </p>
          ) : null}
          {arrivals > 0 ? (
            <p className="m-5 rounded-lg bg-[var(--accent-muted)] p-3 text-sm">
              {arrivals === 1
                ? '1 new work item'
                : `${arrivals} new work items`}{' '}
              —{' '}
              <button
                className="font-bold underline"
                onClick={() => void loadList(filters)}
                type="button"
              >
                Refresh list
              </button>
            </p>
          ) : null}
          {list === null ? (
            listError ? null : (
              <div
                aria-busy="true"
                className="m-5 h-40 animate-pulse rounded-lg bg-[var(--accent-muted)] motion-reduce:animate-none"
              >
                <span className="sr-only">Loading…</span>
              </div>
            )
          ) : list.items.length === 0 ? (
            isFiltered(filters) ? (
              <div className="p-6">
                <p>No work items match these filters.</p>
                <button
                  className="secondary-button mt-5"
                  onClick={() =>
                    setFilters({ ...emptyFilters, sort: filters.sort })
                  }
                  type="button"
                >
                  Clear filters
                </button>
              </div>
            ) : (
              <div className="p-6">
                <p>
                  Nothing is on this board yet. Add your first work item to get
                  started.
                </p>
                <button
                  className="primary-button mt-5"
                  onClick={openDraft}
                  type="button"
                >
                  Add work item
                </button>
              </div>
            )
          ) : (
            <div>
              {list.items.map((item) => {
                const reason = waitingReasons.get(item.id) ?? null;
                const chipShown =
                  isReady(item.state) && (startStatusError || reason !== null);
                const chipId = `waiting-${item.id}`;
                const filedId = `filed-${item.id}`;
                const filed = item.filedBy === undefined ? null : item.filedBy;
                const describedBy = [
                  item.filedBy === undefined ? null : filedId,
                  chipShown ? chipId : null,
                ]
                  .filter((id) => id !== null)
                  .join(' ');
                return (
                  <div
                    className={`flex flex-col gap-2 border-b border-[var(--border)] p-2 last:border-0 sm:flex-row sm:items-center ${selectedId === item.id ? 'bg-[var(--accent-muted)]' : ''}`}
                    key={item.id}
                  >
                    <div className="flex min-w-0 flex-1 flex-col">
                      <button
                        aria-current={
                          selectedId === item.id ? 'true' : undefined
                        }
                        aria-describedby={
                          describedBy === '' ? undefined : describedBy
                        }
                        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg p-2 text-left outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-[var(--focus)] sm:flex-nowrap"
                        onClick={() => openItem(item.id)}
                        ref={(element) => {
                          if (element === null) rows.current.delete(item.id);
                          else rows.current.set(item.id, element);
                        }}
                        type="button"
                      >
                        <span className="rounded bg-amber-100 px-2 py-1 text-xs font-bold text-amber-950 dark:bg-amber-900 dark:text-amber-50">
                          {item.priority ?? '—'}
                        </span>
                        <span className="shrink-0 font-mono text-xs whitespace-nowrap text-[var(--muted)]">
                          {item.key}
                        </span>
                        <TypeTag type={item.type} />
                        <strong className="order-last min-w-0 basis-full break-words sm:order-none sm:flex-1 sm:basis-auto">
                          {item.title}
                        </strong>
                        <span className="rounded-full bg-[var(--accent-muted)] px-2 py-1 text-xs font-bold">
                          {stateLabel(item.state)}
                        </span>
                      </button>
                      {item.filedBy === undefined ? null : (
                        <FiledByLine
                          filedBy={filed}
                          id={filedId}
                          onOpen={openItem}
                        />
                      )}
                    </div>
                    {chipShown ? (
                      <WaitingChip
                        error={startStatusError}
                        id={chipId}
                        onRetry={() => void loadStartStatus()}
                        reason={reason}
                      />
                    ) : null}
                  </div>
                );
              })}
              {list.nextCursor !== null ? (
                <div className="p-4">
                  {moreError ? (
                    <p className="auth-error mt-0 mb-3" role="alert">
                      Cerebra couldn’t load this board. Try again.
                    </p>
                  ) : null}
                  <button
                    className="secondary-button w-full"
                    disabled={loadingMore}
                    onClick={() => void loadMore()}
                    type="button"
                  >
                    {loadingMore
                      ? 'Loading more work items…'
                      : moreError
                        ? 'Try again'
                        : 'Show more work items'}
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </section>
        <div className="grid content-start gap-5">
          <section
            aria-label="Selected work item"
            className={`card ${panelOpen ? 'fixed inset-0 z-20 overflow-y-auto rounded-none lg:static lg:rounded-2xl' : 'hidden min-h-80 lg:block'}`}
          >
            {panelOpen ? (
              <div className="mb-4 flex flex-wrap justify-between gap-3">
                <button
                  className="secondary-button lg:hidden"
                  onClick={closePanel}
                  type="button"
                >
                  Back to board
                </button>
                <button
                  className="secondary-button ml-auto hidden lg:inline-block"
                  onClick={closePanel}
                  type="button"
                >
                  Close
                </button>
              </div>
            ) : null}
            {saveRetry !== null ? (
              <p className="auth-error mt-0 mb-4" role="alert">
                Cerebra couldn’t save your changes. Try again.{' '}
                <button
                  className="font-bold underline"
                  onClick={saveRetry}
                  type="button"
                >
                  Try again
                </button>
              </p>
            ) : null}
            {panel.kind === 'draft' ? (
              <NewWorkItem
                description={description}
                onCancel={closePanel}
                onDescription={setDescription}
                onSave={() => void save()}
                onTitle={setTitle}
                onType={setWorkType}
                saving={saving}
                title={title}
                type={workType}
              />
            ) : selected !== null ? (
              <ItemDetail
                cancelControl={cancelControl}
                comment={comment}
                comments={comments}
                confirming={confirming}
                delivery={
                  deliveryStates.has(selected.state)
                    ? (lead: ReactNode) => (
                        <DeliveryActivity
                          client={deliveryClient}
                          intervalMs={deliveryIntervalMs}
                          itemId={selected.id}
                          key={selected.id}
                          lead={lead}
                          onAnswered={(item) => replaceItem(item as WorkItem)}
                          state={selected.state}
                        />
                      )
                    : null
                }
                dialogHeading={dialogHeading}
                history={history}
                item={selected}
                itemRead={itemRead}
                onCancel={() => {
                  setConfirming(true);
                  setFocusTarget({ kind: 'dialog' });
                }}
                onComment={setComment}
                onConfirmCancel={() => void cancel()}
                onKeep={closeDialog}
                onPostComment={() => void postComment()}
                onPriority={setPriority}
                onRetryComments={() => void readComments(selected.id)}
                onRetryHistory={() => void readHistory(selected.id)}
                onRetryItem={() => void readItem(selected.id)}
                onRoute={(next) => {
                  setRoute(next);
                  setRouteRefused(false);
                }}
                onSaveForLater={closePanel}
                onTab={chooseTab}
                onTriage={() => void triage()}
                priority={priority}
                route={route}
                routeRefused={routeRefused}
                saving={saving}
                costClient={costClient}
                tab={tab}
              />
            ) : panel.kind === 'item' ? (
              <p className="text-[var(--muted)]">Loading…</p>
            ) : (
              <p className="text-[var(--muted)]">
                Select a work item to see its details.
              </p>
            )}
          </section>
          <ProjectCostCard client={costClient} projectId={projectId} />
        </div>
      </div>
    </section>
  );
}

function TypeTag({ type }: { readonly type: WorkItemType }): ReactNode {
  return (
    <span
      className={`shrink-0 rounded border px-1.5 py-0.5 text-xs whitespace-nowrap ${type === 'bug' ? 'border-[var(--danger)] text-[var(--danger)]' : 'border-[var(--control-border)] text-[var(--muted)]'}`}
    >
      {typeLabel(type)}
    </span>
  );
}

function NewWorkItem({
  description,
  onCancel,
  onDescription,
  onSave,
  onTitle,
  onType,
  saving,
  title,
  type,
}: {
  readonly description: string;
  readonly onCancel: () => void;
  readonly onDescription: (value: string) => void;
  readonly onSave: () => void;
  readonly onTitle: (value: string) => void;
  readonly onType: (value: WorkItemType) => void;
  readonly saving: boolean;
  readonly title: string;
  readonly type: WorkItemType;
}): ReactNode {
  return (
    <form
      aria-labelledby="new-work-item-heading"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <h2
        className="text-sm font-bold text-[var(--accent)]"
        id="new-work-item-heading"
      >
        New work item
      </h2>
      <label className="auth-label" htmlFor="work-title">
        What needs to change?
      </label>
      <input
        autoFocus
        className="auth-input"
        id="work-title"
        onChange={(event) => onTitle(event.target.value)}
        required
        value={title}
      />
      <fieldset aria-describedby="work-type-hint" className="min-w-0">
        <legend className="auth-label">Type</legend>
        <div className="grid grid-cols-4 overflow-hidden rounded-lg border border-[var(--control-border)]">
          {workItemTypes.map((option) => (
            <label
              className="min-w-0 border-r border-[var(--control-border)] last:border-r-0"
              key={option}
            >
              <input
                checked={type === option}
                className="peer sr-only"
                name="work-type"
                onChange={() => onType(option)}
                type="radio"
                value={option}
              />
              <span className="block cursor-pointer px-1 py-2 text-center text-sm peer-checked:bg-[var(--accent)] peer-checked:font-bold peer-checked:text-white dark:peer-checked:text-slate-950 peer-focus-visible:ring-3 peer-focus-visible:ring-inset peer-focus-visible:ring-[var(--focus)]">
                {typeLabel(option)}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="mt-2 text-sm text-[var(--muted)]" id="work-type-hint">
        Bugs go to the bug fixer; everything else is planned and built as usual.
      </p>
      <label className="auth-label" htmlFor="work-description">
        Optional
      </label>
      <textarea
        aria-describedby="work-description-hint"
        className="auth-input min-h-28"
        id="work-description"
        onChange={(event) => onDescription(event.target.value)}
        value={description}
      />
      <p
        className="mt-2 text-sm text-[var(--muted)]"
        id="work-description-hint"
      >
        Add enough context for a useful review. You can fill in the rest later.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <button className="primary-button" disabled={saving} type="submit">
          Add work item
        </button>
        <button className="secondary-button" onClick={onCancel} type="button">
          Cancel
        </button>
      </div>
    </form>
  );
}

function ReadFailure({
  onRetry,
  surface,
}: {
  readonly onRetry: () => void;
  readonly surface: string;
}): ReactNode {
  return (
    <p className="auth-error" role="alert">
      Cerebra couldn’t load this {surface}. Try again.{' '}
      <button className="font-bold underline" onClick={onRetry} type="button">
        Try again
      </button>
    </p>
  );
}

function ItemDetail({
  cancelControl,
  costClient,
  comment,
  comments,
  confirming,
  delivery,
  dialogHeading,
  history,
  item,
  itemRead,
  onCancel,
  onComment,
  onConfirmCancel,
  onKeep,
  onPostComment,
  onPriority,
  onRetryComments,
  onRetryHistory,
  onRetryItem,
  onRoute,
  onSaveForLater,
  onTab,
  onTriage,
  priority,
  route,
  routeRefused,
  saving,
  tab,
}: {
  readonly cancelControl: RefObject<HTMLButtonElement | null>;
  readonly costClient: CostClient;
  readonly comment: string;
  readonly comments: Remote<readonly BoardComment[]>;
  readonly confirming: boolean;
  /** Lays out the Overview's opening with its delivery story, when the item has one. */
  readonly delivery: ((lead: ReactNode) => ReactNode) | null;
  readonly dialogHeading: RefObject<HTMLHeadingElement | null>;
  readonly history: Remote<readonly HistoryEntry[]>;
  readonly item: WorkItem;
  readonly itemRead: Remote<WorkItem>;
  readonly onCancel: () => void;
  readonly onComment: (value: string) => void;
  readonly onConfirmCancel: () => void;
  readonly onKeep: () => void;
  readonly onPostComment: () => void;
  readonly onPriority: (value: Priority) => void;
  readonly onRetryComments: () => void;
  readonly onRetryHistory: () => void;
  readonly onRetryItem: () => void;
  readonly onRoute: (value: BoardRoute) => void;
  readonly onSaveForLater: () => void;
  readonly onTab: (value: Tab) => void;
  readonly onTriage: () => void;
  readonly priority: Priority;
  readonly route: BoardRoute;
  readonly routeRefused: boolean;
  readonly saving: boolean;
  readonly tab: Tab;
}): ReactNode {
  const tabs: readonly { readonly label: string; readonly value: Tab }[] = [
    { label: 'Overview', value: 'overview' },
    { label: 'Discussion', value: 'discussion' },
    { label: 'History', value: 'history' },
  ];
  const ended = item.state === 'cancelled' || item.state === 'done';

  return (
    <>
      <p className="text-sm font-bold uppercase tracking-widest text-[var(--muted)]">
        {stateLabel(item.state)}
        {itemRead.loading ? (
          <span className="ml-2 font-normal normal-case tracking-normal">
            Loading…
          </span>
        ) : null}
      </p>
      <p className="mt-2 font-mono text-sm text-[var(--muted)]">
        {item.key} · {typeLabel(item.type)}
      </p>
      <h2 className="mt-1 text-xl font-bold break-words">{item.title}</h2>
      {itemRead.error ? (
        <ReadFailure onRetry={onRetryItem} surface="work item" />
      ) : null}
      <div
        aria-label="Selected work item sections"
        className="mt-5 flex flex-wrap gap-1 border-b border-[var(--border)]"
        role="tablist"
      >
        {tabs.map((candidate) => (
          <button
            aria-controls={`work-item-${candidate.value}`}
            aria-selected={tab === candidate.value}
            className={`-mb-px border-b-2 px-3 py-2 font-bold outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)] ${tab === candidate.value ? 'border-[var(--accent)]' : 'border-transparent text-[var(--muted)]'}`}
            id={`work-item-tab-${candidate.value}`}
            key={candidate.value}
            onClick={() => onTab(candidate.value)}
            role="tab"
            type="button"
          >
            {candidate.label}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={`work-item-tab-${tab}`}
        className="pt-5"
        id={`work-item-${tab}`}
        role="tabpanel"
      >
        {tab === 'overview' ? (
          <>
            {(delivery ?? ((lead: ReactNode) => lead))(
              <>
                <p className="text-[var(--muted)] whitespace-pre-wrap break-words">
                  {item.description || 'No description yet.'}
                </p>
                <p className="mt-3 text-sm">
                  <span className="font-bold">Priority</span>{' '}
                  {item.priority ?? 'Not set'}
                </p>
                <WorkItemCost client={costClient} itemId={item.id} />
              </>,
            )}
            {item.state === 'new' ? (
              <div className="mt-6 border-t border-[var(--border)] pt-5">
                <h3 className="font-bold">Review new work</h3>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  Choose its importance and where it should go next.
                </p>
                <fieldset className="mt-4">
                  <legend className="text-sm font-bold">Priority</legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(['P1', 'P2', 'P3'] as const).map((value) => (
                      <label
                        className="flex items-center gap-2 rounded-lg border border-[var(--control-border)] px-3 py-2 has-checked:border-[var(--accent)] has-checked:bg-[var(--accent-muted)]"
                        key={value}
                      >
                        <input
                          checked={priority === value}
                          name="triage-priority"
                          onChange={() => onPriority(value)}
                          type="radio"
                          value={value}
                        />
                        {value}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="mt-4">
                  <legend className="text-sm font-bold">
                    Where should this go next?
                  </legend>
                  <div className="mt-2 grid gap-2">
                    {routes.map((option) => (
                      <label
                        className="flex gap-3 rounded-lg border border-[var(--control-border)] p-3 has-checked:border-[var(--accent)] has-checked:bg-[var(--accent-muted)]"
                        key={option.value}
                      >
                        <input
                          aria-describedby={`route-${option.value}-hint`}
                          checked={route === option.value}
                          className="mt-1"
                          name="triage-route"
                          onChange={() => onRoute(option.value)}
                          type="radio"
                          value={option.value}
                        />
                        <span>
                          <strong className="block">{option.label}</strong>
                          <span
                            className="text-sm text-[var(--muted)]"
                            id={`route-${option.value}-hint`}
                          >
                            {option.description}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                {routeRefused ? (
                  <p className="auth-error" role="alert">
                    That next step is not available for this project. Choose
                    another route.
                  </p>
                ) : null}
                <div className="mt-6 flex flex-wrap gap-3">
                  <button
                    className="primary-button"
                    disabled={saving}
                    onClick={onTriage}
                    type="button"
                  >
                    Set priority and continue
                  </button>
                  <button
                    className="secondary-button"
                    onClick={onSaveForLater}
                    type="button"
                  >
                    Save for later
                  </button>
                </div>
              </div>
            ) : null}
            {ended ? null : (
              <button
                className="mt-7 text-sm font-bold text-[var(--danger)] underline outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
                onClick={onCancel}
                ref={cancelControl}
                type="button"
              >
                Cancel this work item
              </button>
            )}
            {confirming ? (
              <div
                aria-labelledby="cancel-dialog-heading"
                aria-modal="true"
                className="mt-5 rounded-lg border border-[var(--border)] p-4"
                role="dialog"
              >
                <h3
                  className="font-bold outline-none"
                  id="cancel-dialog-heading"
                  ref={dialogHeading}
                  tabIndex={-1}
                >
                  Cancel this work item
                </h3>
                <p className="mt-2 text-sm text-[var(--muted)]">
                  This ends the work item. It stays on the board as Cancelled.
                </p>
                <div className="mt-4 flex flex-wrap gap-3">
                  <button
                    className="secondary-button"
                    onClick={onKeep}
                    type="button"
                  >
                    Keep work item
                  </button>
                  <button
                    className="primary-button"
                    disabled={saving}
                    onClick={onConfirmCancel}
                    type="button"
                  >
                    Cancel work item
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : tab === 'discussion' ? (
          <>
            {comments.loading && comments.data !== null ? (
              <p className="text-sm text-[var(--muted)]">Loading…</p>
            ) : null}
            {comments.error ? (
              <ReadFailure onRetry={onRetryComments} surface="discussion" />
            ) : comments.data === null ? (
              <p className="text-[var(--muted)]">Loading…</p>
            ) : comments.data.length === 0 ? (
              <p className="text-[var(--muted)]">No discussion yet.</p>
            ) : (
              <ul className="grid gap-3">
                {comments.data.map((entry) => (
                  <li
                    className="rounded-lg border border-[var(--border)] p-3"
                    key={entry.id}
                  >
                    <p className="whitespace-pre-wrap break-words">
                      {entry.body}
                    </p>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      {formatTime(entry.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <form
              className="mt-5"
              onSubmit={(event) => {
                event.preventDefault();
                onPostComment();
              }}
            >
              <label className="auth-label mt-0" htmlFor="work-comment">
                Add a comment
              </label>
              <textarea
                className="auth-input min-h-20"
                id="work-comment"
                onChange={(event) => onComment(event.target.value)}
                value={comment}
              />
              <button
                className="primary-button mt-3"
                disabled={saving || !comment.trim()}
                type="submit"
              >
                Post comment
              </button>
            </form>
          </>
        ) : (
          <>
            {history.loading && history.data !== null ? (
              <p className="text-sm text-[var(--muted)]">Loading…</p>
            ) : null}
            {history.error ? (
              <ReadFailure onRetry={onRetryHistory} surface="history" />
            ) : history.data === null ? (
              <p className="text-[var(--muted)]">Loading…</p>
            ) : history.data.length === 0 ? (
              <p className="text-[var(--muted)]">
                No changes have been recorded yet.
              </p>
            ) : (
              <ol className="grid gap-3">
                {history.data.map((entry, index) => (
                  <li
                    className="border-l-2 border-[var(--border)] pl-3"
                    key={`${entry.createdAt}-${index}`}
                  >
                    <p className="font-bold">
                      {stateLabel(entry.fromState)} →{' '}
                      {stateLabel(entry.toState)}
                    </p>
                    <p className="text-xs text-[var(--muted)]">
                      {actorLabel(entry.actorRole)} ·{' '}
                      {formatTime(entry.createdAt)}
                    </p>
                    {entry.reason ? (
                      <p className="mt-1 text-sm">{entry.reason}</p>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </div>
    </>
  );
}
