import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  browserCostClient,
  formatUsd,
  type CostClient,
  type ItemCost,
  type ProjectCost,
} from './costs';

const explanation =
  'Estimated API-price equivalent for Claude usage. This is not a subscription charge.';

interface Refreshed<T> {
  readonly failed: boolean;
  readonly retry: () => void;
  readonly updating: boolean;
  readonly value: T | null;
}

/** Reads a cost now and every interval; the last value stays shown while the next one loads. */
function useRefreshed<T>(
  read: () => Promise<T>,
  pollIntervalMs: number,
): Refreshed<T> {
  const [value, setValue] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [updating, setUpdating] = useState(true);
  const request = useRef(0);

  const load = useCallback(async () => {
    const current = ++request.current;
    setUpdating(true);
    try {
      const next = await read();
      if (current !== request.current) return;
      setValue(next);
      setFailed(false);
    } catch {
      if (current === request.current) setFailed(true);
    } finally {
      if (current === request.current) setUpdating(false);
    }
  }, [read]);

  useEffect(() => {
    setValue(null);
    void load();
    const timer = window.setInterval(() => void load(), pollIntervalMs);
    return () => {
      window.clearInterval(timer);
      request.current += 1;
    };
  }, [load, pollIntervalMs]);

  return { failed, retry: () => void load(), updating, value };
}

function CostCard({
  children,
  className,
  detailLabel,
  headingLevel,
  details,
  empty,
  emptyText,
  refreshed,
  toggleLabel,
  total,
}: {
  readonly children?: ReactNode;
  readonly className: string;
  readonly detailLabel: string;
  readonly headingLevel: 2 | 3;
  readonly details: ReactNode;
  readonly empty: boolean;
  readonly emptyText: string;
  readonly refreshed: Refreshed<unknown>;
  readonly toggleLabel: string;
  readonly total: number | null;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const detailsId = useId();
  const { failed, retry, updating, value } = refreshed;
  const Heading = headingLevel === 2 ? 'h2' : 'h3';

  return (
    <section aria-labelledby={headingId} className={className}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Heading
          className={headingLevel === 2 ? 'text-lg font-bold' : 'font-bold'}
          id={headingId}
        >
          Cost so far
        </Heading>
        {value !== null && updating ? (
          <span className="text-sm text-[var(--muted)]" role="status">
            Updating…
          </span>
        ) : null}
      </div>
      {value === null && !failed ? (
        <div
          aria-busy="true"
          className="mt-3 h-16 animate-pulse rounded-lg bg-[var(--accent-muted)] motion-reduce:animate-none"
        >
          <span className="sr-only">Loading…</span>
        </div>
      ) : null}
      {failed ? (
        <p className="mt-3 text-sm text-[var(--danger)]" role="alert">
          We couldn't load the cost.{' '}
          <button className="font-bold underline" onClick={retry} type="button">
            Try again
          </button>
          .
        </p>
      ) : null}
      {value !== null && total !== null ? (
        empty ? (
          <p className="mt-3 text-sm text-[var(--muted)]">{emptyText}</p>
        ) : (
          <>
            <p className="mt-3 text-3xl font-bold tracking-tight">
              {formatUsd(total)}
            </p>
            <p className="mt-1 text-sm text-[var(--muted)]">{explanation}</p>
            {children}
            <button
              aria-controls={detailsId}
              aria-expanded={open}
              className="mt-3 rounded-lg text-sm font-bold text-[var(--accent)] outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
              onClick={() => setOpen((current) => !current)}
              type="button"
            >
              {toggleLabel}
            </button>
            <div hidden={!open} id={detailsId}>
              {open ? (
                <ul aria-label={detailLabel} className="mt-2">
                  {details}
                </ul>
              ) : null}
            </div>
          </>
        )
      ) : null}
    </section>
  );
}

function Row({
  amount,
  hint,
  label,
}: {
  readonly amount: number;
  readonly hint: ReactNode;
  readonly label: ReactNode;
}): ReactNode {
  return (
    <li className="flex justify-between gap-3 border-t border-[var(--border)] py-3 first:mt-3">
      <div className="min-w-0">
        <b className="block break-words">{label}</b>
        <span className="block text-sm text-[var(--muted)]">{hint}</span>
      </div>
      <b>{formatUsd(amount)}</b>
    </li>
  );
}

function startedAt(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** What a work item has cost so far, with its runs inline (spec §10). */
export function WorkItemCost({
  client = browserCostClient,
  itemId,
  pollIntervalMs = 30_000,
}: {
  readonly client?: CostClient;
  readonly itemId: string;
  readonly pollIntervalMs?: number;
}): ReactNode {
  const read = useCallback(() => client.forItem(itemId), [client, itemId]);
  const refreshed = useRefreshed<ItemCost>(read, pollIntervalMs);
  const cost = refreshed.value;
  return (
    <CostCard
      className="mt-5 rounded-xl border border-[var(--border)] p-4"
      detailLabel="Cost by run"
      headingLevel={3}
      details={cost?.runs.map((run) => (
        <Row
          amount={run.costUsd}
          hint={startedAt(run.startedAt)}
          key={run.id}
          label={run.agentName ?? 'The assistant'}
        />
      ))}
      empty={cost?.totalUsd === 0}
      emptyText="No usage has been recorded for this work yet."
      refreshed={refreshed}
      toggleLabel="See cost by run"
      total={cost?.totalUsd ?? null}
    />
  );
}

/** What a project has cost so far, never attributing a run without work to a work item (spec §10). */
export function ProjectCostCard({
  client = browserCostClient,
  pollIntervalMs = 30_000,
  projectId,
}: {
  readonly client?: CostClient;
  readonly pollIntervalMs?: number;
  readonly projectId: string;
}): ReactNode {
  const read = useCallback(
    () => client.forProject(projectId),
    [client, projectId],
  );
  const refreshed = useRefreshed<ProjectCost>(read, pollIntervalMs);
  const cost = refreshed.value;
  return (
    <CostCard
      className="card"
      detailLabel="All cost details"
      headingLevel={2}
      details={cost?.runs.map((run) => (
        <Row
          amount={run.costUsd}
          hint={run.agentName ?? 'The assistant'}
          key={run.id}
          label={run.item?.title ?? 'Not linked to work'}
        />
      ))}
      empty={cost?.totalUsd === 0}
      emptyText="No usage has been recorded for this project yet."
      refreshed={refreshed}
      toggleLabel="See all cost details"
      total={cost?.totalUsd ?? null}
    >
      {cost === null ? null : (
        <ul aria-label="Cost split">
          <Row
            amount={cost.workItemsUsd}
            hint="Costs linked to this project's work"
            label="Work items"
          />
          <Row
            amount={cost.notLinkedUsd}
            hint="Runs that had no work item"
            label="Not linked to work"
          />
        </ul>
      )}
    </CostCard>
  );
}
