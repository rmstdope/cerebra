import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import {
  agentTypeName,
  browserCredentialClient,
  joinWithAnd,
  type CredentialAttention,
  type CredentialClient,
  type CredentialOverview,
  type CredentialRow,
  type CredentialScope,
} from './credentials';
import { trapFocus } from './focus-trap';

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

const tabStorageKey = 'cerebra.credentials.tab';

const replaceWarning =
  'Replacing a credential: saving a matching name and scope replaces its existing value. Active work keeps the value it already received.';

interface CredentialsPageProps {
  readonly client?: CredentialClient;
  readonly projectId: string | null;
  readonly storage: Storage;
}

interface PanelState {
  readonly mode: 'add' | 'replace';
  readonly name: string;
  readonly scope: CredentialScope;
}

function storedTab(storage: Storage): CredentialScope {
  try {
    return storage.getItem(tabStorageKey) === 'instance'
      ? 'instance'
      : 'project';
  } catch {
    return 'project';
  }
}

function rowKey(row: Pick<CredentialRow, 'name' | 'scope'>): string {
  return `${row.scope}:${row.name}`;
}

function scopeLabel(scope: CredentialScope): string {
  return scope === 'project'
    ? 'Project credential'
    : 'Every-project credential';
}

function lastUsed(value: string | null): ReactNode {
  if (value === null) {
    return 'Never';
  }
  const used = new Date(value);
  if (used.toDateString() === new Date().toDateString()) {
    return (
      <span className="rounded-full bg-[var(--accent-muted)] px-2 py-0.5 text-xs font-bold text-[var(--accent)]">
        Used today
      </span>
    );
  }
  return `Used on ${used.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })}`;
}

function usedBy(row: CredentialRow): ReactNode {
  if (row.needsAttention) {
    return (
      <span className="rounded-full border border-[var(--danger)] px-2 py-0.5 text-xs font-bold text-[var(--danger)]">
        Needs attention
      </span>
    );
  }
  if (row.usedByEveryAgent) {
    return 'Every Claude agent';
  }
  if (row.usedBy.length > 0) {
    return row.usedBy.map((type) => agentTypeName(type, true)).join(', ');
  }
  return 'Not used yet';
}

function attentionSentence(entry: CredentialAttention): string {
  const who =
    entry.everyAgent || entry.agentTypes.length === 0
      ? 'Agents'
      : joinWithAnd(entry.agentTypes.map((type) => agentTypeName(type, true)));
  return `${who} cannot start until “${entry.name}” is replaced or removed from their setup.`;
}

export function CredentialsPage({
  client = browserCredentialClient,
  projectId,
  storage,
}: CredentialsPageProps): ReactNode {
  const [chosenTab, setChosenTab] = useState<CredentialScope>(() =>
    storedTab(storage),
  );
  const tab: CredentialScope = projectId === null ? 'instance' : chosenTab;
  const [data, setData] = useState<CredentialOverview | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [notice, setNotice] = useState('');
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [removing, setRemoving] = useState<CredentialRow | null>(null);
  const [focusTarget, setFocusTarget] = useState<
    { readonly key: string } | { readonly index: number } | null
  >(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const manageButtons = useRef(new Map<string, HTMLButtonElement>());
  const rowElements = useRef(new Map<string, HTMLLIElement>());
  const list = useRef<HTMLUListElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const menuAction = useRef<(() => void) | null>(null);
  const refocusAfterSave = useRef(false);

  useEffect(() => {
    if (removing !== null) {
      keepButton.current?.focus();
    }
  }, [removing]);

  async function load(refresh = false): Promise<void> {
    setLoadFailed(false);
    if (!refresh) {
      setData(null);
    }
    try {
      setData(await client.overview(projectId));
    } catch {
      setLoadFailed(true);
    }
  }

  useEffect(() => {
    void load();
  }, [client, projectId]);

  const rows: readonly CredentialRow[] =
    data === null
      ? []
      : tab === 'project'
        ? data.projectCredentials
        : data.instanceCredentials;

  useEffect(() => {
    if (focusTarget === null || data === null) {
      return;
    }
    if ('key' in focusTarget) {
      rowElements.current.get(focusTarget.key)?.focus();
    } else {
      const next = rows[Math.min(focusTarget.index, rows.length - 1)];
      if (next === undefined) {
        list.current?.focus();
      } else {
        rowElements.current.get(rowKey(next))?.focus();
      }
    }
    setFocusTarget(null);
  }, [focusTarget, data, tab]);

  useEffect(() => {
    if (!refocusAfterSave.current || data === null) {
      return;
    }
    refocusAfterSave.current = false;
    // The empty state's button leaves once the first credential is listed.
    if (returnFocus.current?.isConnected !== true) {
      addButton.current?.focus();
    }
  }, [data]);

  function chooseTab(next: CredentialScope): void {
    setChosenTab(next);
    try {
      storage.setItem(tabStorageKey, next);
    } catch {
      // The tab still changes; it just isn't remembered.
    }
  }

  function openPanel(state: PanelState, from: HTMLElement | null): void {
    returnFocus.current = from;
    setPanel(state);
  }

  function closePanel(): void {
    setPanel(null);
    returnFocus.current?.focus();
  }

  function viewCredential(entry: CredentialAttention): void {
    const inProject =
      data?.projectCredentials.some((row) => row.name === entry.name) ?? false;
    const scope: CredentialScope =
      entry.scope ?? (inProject ? 'project' : 'instance');
    if (scope !== tab) {
      chooseTab(scope);
    }
    setFocusTarget({ key: rowKey({ name: entry.name, scope }) });
  }

  async function remove(row: CredentialRow): Promise<void> {
    if (row.id === null) {
      return;
    }
    const index = rows.findIndex((entry) => rowKey(entry) === rowKey(row));
    setRemoving(null);
    try {
      await client.remove(row.id);
      setNotice(`“${row.name}” removed.`);
      await load(true);
      setFocusTarget({ index: Math.max(index, 0) });
    } catch {
      setNotice(`Couldn’t remove “${row.name}”. Try again.`);
      manageButtons.current.get(rowKey(row))?.focus();
    }
  }

  const projectName = data?.project?.name ?? '';
  const attention = data?.attention ?? [];

  return (
    <section aria-labelledby="credentials-heading">
      <h1
        className="text-3xl font-bold tracking-tight sm:text-4xl"
        id="credentials-heading"
      >
        Credentials
      </h1>
      <p className="mt-1 text-[var(--muted)]">
        Add credentials once, then review only where they apply and when they
        were last used.
      </p>
      <p
        className={
          notice === ''
            ? 'sr-only'
            : 'mt-5 rounded-lg border border-[var(--border)] bg-[var(--accent-muted)] p-3 text-sm font-semibold'
        }
        role="status"
      >
        {notice}
      </p>
      {attention.length > 0 ? (
        <section
          aria-labelledby="credential-attention"
          className="mt-5 rounded-xl border border-[var(--danger)] p-4"
        >
          <h2
            className="font-bold text-[var(--danger)]"
            id="credential-attention"
          >
            {attention.length === 1
              ? '1 credential needs attention'
              : `${attention.length} credentials need attention`}
          </h2>
          <ul className="mt-2 space-y-2">
            {attention.map((entry) => (
              <li
                className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                key={`${entry.scope ?? 'missing'}:${entry.name}`}
              >
                <span className="text-sm">{attentionSentence(entry)}</span>
                <button
                  aria-label={`View credential ${entry.name}`}
                  className="secondary-button shrink-0"
                  onClick={() => viewCredential(entry)}
                  type="button"
                >
                  View credential
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          aria-label="Where credentials apply"
          className="flex gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-1"
          role="tablist"
        >
          {(projectId === null
            ? (['instance'] as const)
            : (['project', 'instance'] as const)
          ).map((scope) => (
            <button
              aria-controls="credentials-panel"
              aria-selected={tab === scope}
              className={`flex-1 rounded-md px-3 py-2 text-sm font-bold outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)] ${
                tab === scope
                  ? 'bg-[var(--accent-muted)] text-[var(--accent)]'
                  : 'text-[var(--muted)]'
              }`}
              key={scope}
              onClick={() => chooseTab(scope)}
              role="tab"
              type="button"
            >
              {scope === 'project' ? 'This project' : 'Every project'}
            </button>
          ))}
        </div>
        <button
          className="primary-button"
          onClick={(event) =>
            openPanel(
              { mode: 'add', name: '', scope: tab },
              event.currentTarget,
            )
          }
          ref={addButton}
          type="button"
        >
          Add credential
        </button>
      </div>
      <div className="card mt-4" id="credentials-panel" role="tabpanel">
        {tab === 'project' ? (
          <p className="mb-4 rounded-lg bg-[var(--accent-muted)] p-3 text-sm">
            Project credentials take priority. A credential here is used before
            one with the same name saved for every project.
          </p>
        ) : null}
        {loadFailed ? (
          <div role="alert">
            <p>
              Cerebra couldn’t load credentials. Nothing has been changed. Try
              again.
            </p>
            <button
              className="secondary-button mt-3"
              onClick={() => void load()}
              type="button"
            >
              Try again
            </button>
          </div>
        ) : data === null ? (
          <ul aria-busy="true" aria-label="Loading credentials">
            {[0, 1, 2].map((index) => (
              <li
                className="my-2 h-12 rounded-lg bg-[var(--accent-muted)] opacity-60 motion-safe:animate-pulse"
                data-testid="credential-placeholder"
                key={index}
              />
            ))}
          </ul>
        ) : rows.length === 0 ? (
          <div className="py-6 text-center">
            <p className="font-bold">
              {tab === 'project'
                ? 'No credentials saved for this project'
                : 'No credentials saved for every project'}
            </p>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {tab === 'project'
                ? 'Project credentials can override an every-project credential with the same name.'
                : 'Save a credential here to use it in every project.'}
            </p>
            <button
              className="secondary-button mt-4"
              onClick={(event) =>
                openPanel(
                  { mode: 'add', name: '', scope: tab },
                  event.currentTarget,
                )
              }
              type="button"
            >
              Add credential
            </button>
          </div>
        ) : (
          <ul
            aria-label={
              tab === 'project'
                ? 'This project’s credentials'
                : 'Every-project credentials'
            }
            className="divide-y divide-[var(--border)] outline-none"
            ref={list}
            tabIndex={-1}
          >
            {rows.map((row) => (
              <li
                aria-label={`${row.name}, ${scopeLabel(row.scope)}`}
                className="grid gap-2 py-3 outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)] sm:grid-cols-[2fr_1.5fr_1fr_auto] sm:items-center"
                key={rowKey(row)}
                ref={(element) => {
                  if (element === null) {
                    rowElements.current.delete(rowKey(row));
                  } else {
                    rowElements.current.set(rowKey(row), element);
                  }
                }}
                tabIndex={-1}
              >
                <div>
                  <p className="font-bold break-words">{row.name}</p>
                  <p className="text-sm text-[var(--muted)]">
                    {scopeLabel(row.scope)}
                  </p>
                </div>
                <div className="text-sm">{usedBy(row)}</div>
                <div className="text-sm text-[var(--muted)]">
                  {lastUsed(row.lastUsedAt)}
                </div>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      aria-label={`Manage ${row.name}`}
                      className="secondary-button justify-self-start"
                      ref={(element) => {
                        if (element === null) {
                          manageButtons.current.delete(rowKey(row));
                        } else {
                          manageButtons.current.set(rowKey(row), element);
                        }
                      }}
                      type="button"
                    >
                      Manage
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      align="end"
                      className="z-10 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-xl outline-none"
                      onCloseAutoFocus={(event) => {
                        const action = menuAction.current;
                        if (action !== null) {
                          event.preventDefault();
                          menuAction.current = null;
                          action();
                        }
                      }}
                      sideOffset={6}
                    >
                      <DropdownMenu.Item
                        className="rounded-lg px-3 py-2 text-sm font-medium outline-none data-[highlighted]:bg-[var(--accent-muted)]"
                        onSelect={() => {
                          menuAction.current = () =>
                            openPanel(
                              {
                                mode: 'replace',
                                name: row.name,
                                scope: row.scope,
                              },
                              manageButtons.current.get(rowKey(row)) ?? null,
                            );
                        }}
                      >
                        Replace credential
                      </DropdownMenu.Item>
                      {row.id !== null ? (
                        <DropdownMenu.Item
                          className="rounded-lg px-3 py-2 text-sm font-medium text-[var(--danger)] outline-none data-[highlighted]:bg-[var(--accent-muted)]"
                          onSelect={() => {
                            menuAction.current = () => setRemoving(row);
                          }}
                        >
                          Remove credential
                        </DropdownMenu.Item>
                      ) : null}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </li>
            ))}
          </ul>
        )}
      </div>
      {panel !== null ? (
        <CredentialPanel
          client={client}
          existing={data}
          initial={panel}
          onClose={closePanel}
          onSaved={(name, replaced) => {
            setNotice(`“${name}” ${replaced ? 'replaced' : 'saved'}.`);
            closePanel();
            refocusAfterSave.current = true;
            void load(true);
          }}
          projectId={projectId}
          projectName={projectName}
        />
      ) : null}
      {removing !== null ? (
        <div
          aria-describedby="remove-credential-description"
          aria-labelledby="remove-credential-title"
          aria-modal="true"
          className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 sm:items-center sm:p-5"
          onKeyDown={(event) =>
            trapFocus(event, () => {
              manageButtons.current.get(rowKey(removing))?.focus();
              setRemoving(null);
            })
          }
          role="alertdialog"
        >
          <section className="card w-full rounded-b-none sm:max-w-md sm:rounded-b-2xl">
            <h2 id="remove-credential-title">Remove “{removing.name}”?</h2>
            <div id="remove-credential-description">
              <p className="mt-3 text-[var(--muted)]">
                It will no longer be available to new work. Work already under
                way keeps the value it received.
              </p>
              <p className="mt-3 text-sm text-[var(--muted)]">
                This cannot be undone. You can add a new credential with the
                same name later.
              </p>
            </div>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <button
                className="secondary-button w-full sm:w-auto"
                ref={keepButton}
                onClick={() => {
                  manageButtons.current.get(rowKey(removing))?.focus();
                  setRemoving(null);
                }}
                type="button"
              >
                Keep credential
              </button>
              <button
                className="primary-button w-full bg-[var(--danger)] sm:w-auto"
                onClick={() => void remove(removing)}
                type="button"
              >
                Remove credential
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function CredentialPanel({
  client,
  existing,
  initial,
  onClose,
  onSaved,
  projectId,
  projectName,
}: {
  readonly client: CredentialClient;
  readonly existing: CredentialOverview | null;
  readonly initial: PanelState;
  readonly onClose: () => void;
  readonly onSaved: (name: string, replaced: boolean) => void;
  readonly projectId: string | null;
  readonly projectName: string;
}): ReactNode {
  const replacing = initial.mode === 'replace';
  const [name, setName] = useState(initial.name);
  const [scope, setScope] = useState<CredentialScope>(
    projectId === null ? 'instance' : initial.scope,
  );
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [failedName, setFailedName] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const valueInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (replacing ? valueInput : nameInput).current?.focus();
  }, [replacing]);

  const trimmed = name.trim();
  const matches =
    replacing ||
    (existing !== null &&
      (scope === 'project'
        ? existing.projectCredentials
        : existing.instanceCredentials
      ).some((row) => row.id !== null && row.name === trimmed));
  const canSave = !saving && trimmed !== '' && value !== '';

  async function save(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSave) {
      return;
    }
    setSaving(true);
    setFailedName(null);
    try {
      const result = await client.save({
        name: trimmed,
        ...(scope === 'project' && projectId !== null ? { projectId } : {}),
        scope,
        value,
      });
      setValue('');
      onSaved(result.name, result.replaced);
    } catch {
      setSaving(false);
      setValue('');
      setFailedName(trimmed);
      valueInput.current?.focus();
    }
  }

  return (
    <div
      className="fixed inset-0 z-20 bg-black/40"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        aria-labelledby="credential-panel-title"
        aria-modal="true"
        className="fixed inset-0 overflow-y-auto bg-[var(--surface)] p-6 shadow-xl sm:left-auto sm:w-[28rem]"
        onKeyDown={(event) => trapFocus(event, onClose)}
        role="dialog"
      >
        <form onSubmit={(event) => void save(event)}>
          <div className="flex items-start justify-between gap-3">
            <h2 className="text-xl font-bold" id="credential-panel-title">
              {replacing ? 'Replace a credential' : 'Add a credential'}
            </h2>
            <button
              aria-label="Close"
              className="rounded-lg px-2 py-1 text-xl outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
              onClick={onClose}
              type="button"
            >
              ×
            </button>
          </div>
          {failedName !== null ? (
            <p className="auth-error" role="alert">
              Couldn’t save “{failedName}”. It was not added. Check the value
              and try again.
            </p>
          ) : null}
          <label className="auth-label" htmlFor="credential-name">
            Name
          </label>
          <input
            aria-describedby="credential-name-help"
            autoComplete="off"
            className="auth-input"
            id="credential-name"
            onChange={(event) => setName(event.target.value)}
            readOnly={replacing}
            ref={nameInput}
            value={name}
          />
          <p
            className="mt-1 text-sm text-[var(--muted)]"
            id="credential-name-help"
          >
            Use a clear name so you can recognise it later.
          </p>
          <fieldset className="mt-4">
            <legend className="auth-label">Where it applies</legend>
            {projectId !== null ? (
              <label className="flex items-center gap-2 py-1">
                <input
                  checked={scope === 'project'}
                  disabled={replacing && scope !== 'project'}
                  name="credential-scope"
                  onChange={() => setScope('project')}
                  type="radio"
                />
                This project — {projectName}
              </label>
            ) : null}
            <label className="flex items-center gap-2 py-1">
              <input
                checked={scope === 'instance'}
                disabled={replacing && scope !== 'instance'}
                name="credential-scope"
                onChange={() => setScope('instance')}
                type="radio"
              />
              Every project
            </label>
          </fieldset>
          <label className="auth-label" htmlFor="credential-value">
            Credential value
          </label>
          <input
            aria-describedby="credential-value-help"
            aria-invalid={failedName !== null}
            autoComplete="off"
            className="auth-input"
            id="credential-value"
            onChange={(event) => setValue(event.target.value)}
            ref={valueInput}
            spellCheck={false}
            type="password"
            value={value}
          />
          <p
            className="mt-1 text-sm text-[var(--muted)]"
            id="credential-value-help"
          >
            Paste the value. Cerebra never displays it after you save.
          </p>
          {matches ? (
            <p className="mt-4 rounded-lg border-l-4 border-amber-500 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-50">
              {replaceWarning}
            </p>
          ) : null}
          <p className="mt-4 text-sm text-[var(--muted)]">
            Its value is saved securely and will not be shown again.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
            <button
              className="secondary-button w-full sm:w-auto"
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
            <button
              className="primary-button w-full sm:w-auto"
              disabled={!canSave}
              type="submit"
            >
              {saving ? 'Saving credential…' : 'Save credential'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
