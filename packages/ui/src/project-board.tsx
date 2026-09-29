import { useEffect, useRef, useState, type ReactNode } from 'react';

import {
  browserBoardClient,
  type BoardClient,
  type BoardRoute,
  type Priority,
  type WorkItem,
} from './board';

function label(state: string): string {
  return state === 'new'
    ? 'Needs triage'
    : state
        .replaceAll('_', ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function ProjectBoard({
  boardClient = browserBoardClient,
  projectId,
}: {
  readonly boardClient?: BoardClient;
  readonly projectId: string;
}): ReactNode {
  const [items, setItems] = useState<readonly WorkItem[] | null>(null);
  const [selected, setSelected] = useState<WorkItem | null>(null);
  const [draft, setDraft] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [priority, setPriority] = useState<Priority>('P2');
  const [route, setRoute] = useState<BoardRoute>('grooming_ready');
  const [confirming, setConfirming] = useState(false);
  const cancelButton = useRef<HTMLButtonElement>(null);

  const refresh = async () => {
    setError(false);
    try {
      const next = await boardClient.list(projectId);
      setItems(next);
      setSelected(
        (current) =>
          next.find((item) => item.id === current?.id) ?? next[0] ?? null,
      );
    } catch {
      setError(true);
    }
  };

  useEffect(() => {
    void refresh();
  }, [projectId]);

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    setError(false);
    try {
      const item = await boardClient.create(projectId, {
        description,
        title: title.trim(),
      });
      setItems((current) => [...(current ?? []), item]);
      setSelected(item);
      setDraft(false);
      setTitle('');
      setDescription('');
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  const triage = async () => {
    if (selected === null) return;
    setSaving(true);
    setError(false);
    try {
      const item = await boardClient.triage(selected.id, priority, route);
      setItems(
        (current) =>
          current?.map((candidate) =>
            candidate.id === item.id ? item : candidate,
          ) ?? [item],
      );
      setSelected(item);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  const cancel = async () => {
    if (selected === null) return;
    setSaving(true);
    try {
      const item = await boardClient.cancel(selected.id);
      setItems(
        (current) =>
          current?.map((candidate) =>
            candidate.id === item.id ? item : candidate,
          ) ?? [item],
      );
      setSelected(item);
      setConfirming(false);
      window.setTimeout(() => cancelButton.current?.focus());
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-320 px-5 py-10 sm:py-14">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            Project board
          </h1>
          <p className="mt-1 text-[var(--muted)]">
            See what is waiting, in progress and finished.
          </p>
        </div>
        <button
          className="primary-button"
          onClick={() => setDraft(true)}
          type="button"
        >
          Add work item
        </button>
      </div>
      {error ? (
        <p
          className="mt-5 rounded-lg bg-red-50 p-3 text-[var(--danger)] dark:bg-red-950"
          role="alert"
        >
          Cerebra couldn’t{' '}
          {items === null ? 'load this board' : 'save your changes'}. Try again.{' '}
          <button
            className="underline"
            onClick={() => void refresh()}
            type="button"
          >
            Try again
          </button>
        </p>
      ) : null}
      <div className="mt-7 grid gap-5 lg:grid-cols-[1.4fr_.9fr]">
        <section className="card p-0" aria-label="Work items">
          <div className="flex items-center justify-between border-b border-[var(--border)] p-5">
            <h2 className="text-lg font-bold">Work items</h2>
            <span className="text-sm text-[var(--muted)]">
              {items?.length ?? 'Loading…'}
              {items ? ' items' : ''}
            </span>
          </div>
          {items === null ? (
            <p className="p-5 text-[var(--muted)]">Loading…</p>
          ) : items.length === 0 ? (
            <div className="p-6">
              <p>
                Nothing is on this board yet. Add your first work item to get
                started.
              </p>
              <button
                className="primary-button mt-5"
                onClick={() => setDraft(true)}
                type="button"
              >
                Add work item
              </button>
            </div>
          ) : (
            <div>
              {items.map((item) => (
                <button
                  className={`flex w-full items-center gap-3 border-b border-[var(--border)] p-4 text-left last:border-0 ${selected?.id === item.id ? 'bg-[var(--accent-muted)]' : ''}`}
                  key={item.id}
                  onClick={() => setSelected(item)}
                  type="button"
                >
                  <span className="rounded bg-amber-100 px-2 py-1 text-xs font-bold text-amber-950 dark:bg-amber-900 dark:text-amber-50">
                    {item.priority ?? '—'}
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate">{item.title}</strong>
                    <span className="text-sm text-[var(--muted)]">
                      {label(item.state)}
                    </span>
                  </span>
                  <span className="rounded-full bg-[var(--accent-muted)] px-2 py-1 text-xs font-bold">
                    {label(item.state)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
        <section className="card min-h-80" aria-label="Selected work item">
          {draft ? (
            <NewWorkItem
              description={description}
              onCancel={() => setDraft(false)}
              onDescription={setDescription}
              onSave={() => void save()}
              onTitle={setTitle}
              saving={saving}
              title={title}
            />
          ) : selected ? (
            <ItemDetail
              cancelButton={cancelButton}
              confirming={confirming}
              onCancel={() => setConfirming(true)}
              onConfirmCancel={() => void cancel()}
              onKeep={() => {
                setConfirming(false);
                window.setTimeout(() => cancelButton.current?.focus());
              }}
              onPriority={setPriority}
              onRoute={setRoute}
              onTriage={() => void triage()}
              priority={priority}
              route={route}
              saving={saving}
              item={selected}
            />
          ) : (
            <p className="text-[var(--muted)]">
              Select a work item to inspect it.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}

function NewWorkItem({
  description,
  onCancel,
  onDescription,
  onSave,
  onTitle,
  saving,
  title,
}: {
  readonly description: string;
  readonly onCancel: () => void;
  readonly onDescription: (value: string) => void;
  readonly onSave: () => void;
  readonly onTitle: (value: string) => void;
  readonly saving: boolean;
  readonly title: string;
}): ReactNode {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <p className="text-sm font-bold text-[var(--accent)]">New work item</p>
      <label className="auth-label" htmlFor="work-title">
        What needs to change?
      </label>
      <input
        className="auth-input"
        id="work-title"
        onChange={(event) => onTitle(event.target.value)}
        required
        value={title}
      />
      <label className="auth-label" htmlFor="work-description">
        Optional
      </label>
      <textarea
        className="auth-input min-h-28"
        id="work-description"
        onChange={(event) => onDescription(event.target.value)}
        value={description}
      />
      <p className="mt-2 text-sm text-[var(--muted)]">
        Add enough context for a useful review. You can fill in the rest later.
      </p>
      <div className="mt-6 flex gap-3">
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

function ItemDetail({
  cancelButton,
  confirming,
  item,
  onCancel,
  onConfirmCancel,
  onKeep,
  onPriority,
  onRoute,
  onTriage,
  priority,
  route,
  saving,
}: {
  readonly cancelButton: React.RefObject<HTMLButtonElement | null>;
  readonly confirming: boolean;
  readonly item: WorkItem;
  readonly onCancel: () => void;
  readonly onConfirmCancel: () => void;
  readonly onKeep: () => void;
  readonly onPriority: (value: Priority) => void;
  readonly onRoute: (value: BoardRoute) => void;
  readonly onTriage: () => void;
  readonly priority: Priority;
  readonly route: BoardRoute;
  readonly saving: boolean;
}): ReactNode {
  return (
    <>
      <p className="text-sm font-bold uppercase tracking-widest text-[var(--muted)]">
        {label(item.state)}
      </p>
      <h2 className="mt-2 text-xl font-bold">{item.title}</h2>
      <p className="mt-3 text-[var(--muted)]">
        {item.description || 'No additional context yet.'}
      </p>
      {item.state === 'new' ? (
        <div className="mt-7 border-t border-[var(--border)] pt-5">
          <h3 className="font-bold">Review new work</h3>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Choose its importance and where it should go next.
          </p>
          <label className="auth-label" htmlFor="priority">
            Priority
          </label>
          <select
            className="auth-input"
            id="priority"
            onChange={(event) => onPriority(event.target.value as Priority)}
            value={priority}
          >
            {['P1', 'P2', 'P3'].map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <label className="auth-label" htmlFor="route">
            Where should this go next?
          </label>
          <select
            className="auth-input"
            id="route"
            onChange={(event) => onRoute(event.target.value as BoardRoute)}
            value={route}
          >
            <option value="grooming_ready">Groom the outcome</option>
            <option value="design_ready">Send to design</option>
            <option value="build_ready">Send to build</option>
          </select>
          <button
            className="primary-button mt-6"
            disabled={saving}
            onClick={onTriage}
            type="button"
          >
            Set priority and continue
          </button>
        </div>
      ) : null}
      <button
        className="mt-7 text-sm font-bold text-[var(--danger)] underline"
        onClick={onCancel}
        ref={cancelButton}
        type="button"
      >
        Cancel this work item
      </button>
      {confirming ? (
        <div
          aria-modal="true"
          className="mt-5 rounded-lg border border-[var(--border)] p-4"
          role="dialog"
        >
          <h3 tabIndex={-1}>Cancel this work item</h3>
          <p className="mt-2 text-sm text-[var(--muted)]">
            This ends the item.
          </p>
          <div className="mt-4 flex gap-3">
            <button className="secondary-button" onClick={onKeep} type="button">
              Keep work item
            </button>
            <button
              className="primary-button"
              onClick={onConfirmCancel}
              type="button"
            >
              Cancel work item
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
