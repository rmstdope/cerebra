import { useEffect, useRef, useState, type ReactNode } from 'react';

import {
  agentTypeName,
  browserCredentialClient,
  CredentialRequestError,
  type AgentCredentialEntry,
  type AgentCredentialSettings,
  type CredentialClient,
  type CredentialDeliveryMethod,
} from './credentials';
import { trapFocus } from './focus-trap';

export const agentTypes = [
  'groomer',
  'designer',
  'producer',
  'bugfixer',
  'reviewer',
  'assistant',
] as const;

const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;

function deliveryLabel(delivery: CredentialDeliveryMethod): string {
  return delivery === 'environment' ? 'Environment variable' : 'File';
}

function destinationProblem(
  delivery: CredentialDeliveryMethod,
  destination: string,
  taken: readonly string[],
): string | null {
  if (delivery === 'environment' && !envName.test(destination)) {
    return 'Use letters, numbers and underscores, starting with a letter.';
  }
  if (
    delivery === 'file' &&
    (!destination.startsWith('/') ||
      destination.endsWith('/') ||
      destination.split('/').some((part) => part === '..' || part === '.') ||
      destination.includes('//') ||
      destination === '/work' ||
      destination.startsWith('/work/'))
  ) {
    return 'Use a full path outside /work, such as /run/secrets/token.';
  }
  if (
    taken.includes(destination) ||
    (delivery === 'environment' &&
      destination.toUpperCase().startsWith('CEREBRA_'))
  ) {
    return alreadyUsed(destination);
  }
  return null;
}

function alreadyUsed(destination: string): string {
  return `“${destination}” is already used. Choose a different name or change the existing credential.`;
}

export function AgentTypesList(): ReactNode {
  return (
    <section aria-labelledby="agent-types-heading">
      <h1
        className="text-3xl font-bold tracking-tight sm:text-4xl"
        id="agent-types-heading"
      >
        Agent types
      </h1>
      <ul className="card mt-6 divide-y divide-[var(--border)]">
        {agentTypes.map((type) => (
          <li
            className="flex items-center justify-between gap-3 py-3"
            key={type}
          >
            <span className="font-bold">{agentTypeName(type)}</span>
            <a
              aria-label={`Edit ${agentTypeName(type)}`}
              className="secondary-button"
              href={`#/settings/agents/${type}`}
            >
              Edit
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface DialogState {
  readonly index: number | null;
  readonly returnTo: HTMLElement | null;
}

export function AgentCredentialsPage({
  agentType,
  client = browserCredentialClient,
  projectId,
}: {
  readonly agentType: string;
  readonly client?: CredentialClient;
  readonly projectId: string;
}): ReactNode {
  const [loaded, setLoaded] = useState<AgentCredentialSettings | null>(null);
  const [draft, setDraft] = useState<readonly AgentCredentialEntry[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [usedDestination, setUsedDestination] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);

  async function load(): Promise<void> {
    setLoadFailed(false);
    setLoaded(null);
    try {
      const next = await client.agentCredentials(projectId, agentType);
      setLoaded(next);
      setDraft(next.entries);
    } catch {
      setLoadFailed(true);
    }
  }

  useEffect(() => {
    void load();
  }, [client, projectId, agentType]);

  const changed =
    loaded !== null && JSON.stringify(loaded.entries) !== JSON.stringify(draft);

  async function save(): Promise<void> {
    setSaving(true);
    setSaveFailed(false);
    setUsedDestination(null);
    try {
      const next = await client.setAgentCredentials(
        projectId,
        agentType,
        draft
          .filter((entry) => !entry.builtIn)
          .map(({ credentialName, delivery, destination }) => ({
            credentialName,
            delivery,
            destination,
          })),
      );
      setLoaded(next);
      setDraft(next.entries);
    } catch (error) {
      setSaveFailed(true);
      if (
        error instanceof CredentialRequestError &&
        error.code === 'duplicate_destination' &&
        error.destination !== null
      ) {
        setUsedDestination(error.destination);
      }
    } finally {
      setSaving(false);
    }
  }

  function closeDialog(): void {
    const target = dialog?.returnTo ?? null;
    setDialog(null);
    target?.focus();
  }

  const name = agentTypeName(agentType);

  return (
    <section aria-labelledby="agent-heading">
      <a
        className="text-sm font-bold text-[var(--accent)] outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
        href="#/settings/agents"
      >
        ← Agent types
      </a>
      <h1
        className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl"
        id="agent-heading"
      >
        Edit {name}
      </h1>
      <p className="mt-1 text-[var(--muted)]">
        Set what every {name.toLowerCase()} may use when it works on this
        project.
      </p>
      <section
        aria-labelledby="agent-credentials-heading"
        className="card mt-6"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 id="agent-credentials-heading">
              Credentials this agent may use
            </h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Each saved credential is listed by name only.
            </p>
          </div>
          {loaded !== null ? (
            <button
              className="secondary-button"
              onClick={(event) =>
                setDialog({ index: null, returnTo: event.currentTarget })
              }
              ref={addButton}
              type="button"
            >
              Add credential
            </button>
          ) : null}
        </div>
        {loadFailed ? (
          <div className="mt-4" role="alert">
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
        ) : loaded === null ? (
          <ul
            aria-busy="true"
            aria-label="Loading credentials"
            className="mt-4"
          >
            {[0, 1].map((index) => (
              <li
                className="my-2 h-12 rounded-lg bg-[var(--accent-muted)] opacity-60 motion-safe:animate-pulse"
                key={index}
              />
            ))}
          </ul>
        ) : (
          <>
            <ul className="mt-4 divide-y divide-[var(--border)]">
              {draft.map((entry, index) => (
                <li
                  aria-label={entry.credentialName}
                  className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                  key={`${entry.delivery}:${entry.destination}`}
                >
                  <div>
                    <p className="font-bold break-words">
                      {entry.credentialName}
                    </p>
                    <p className="text-sm break-all text-[var(--muted)]">
                      {deliveryLabel(entry.delivery)} · {entry.destination}
                    </p>
                    {entry.needsAttention ? (
                      <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-[var(--danger)]">
                        This project’s credential needs attention
                        <span className="rounded-full border border-[var(--danger)] px-2 py-0.5 text-xs font-bold">
                          Cannot start
                        </span>
                      </p>
                    ) : null}
                  </div>
                  {entry.builtIn ? (
                    <span className="text-sm text-[var(--muted)]">
                      Always given
                    </span>
                  ) : (
                    <button
                      aria-label={`Change ${entry.credentialName}`}
                      className="secondary-button self-start sm:self-auto"
                      onClick={(event) =>
                        setDialog({ index, returnTo: event.currentTarget })
                      }
                      type="button"
                    >
                      Change
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {saveFailed ? (
              <div className="mt-4" role="alert">
                <p className="text-[var(--danger)]">
                  Couldn’t save these credentials. Your choices are still here.
                </p>
                {usedDestination !== null ? (
                  <p className="mt-1 text-sm text-[var(--danger)]">
                    {alreadyUsed(usedDestination)}
                  </p>
                ) : null}
                <button
                  className="secondary-button mt-3"
                  onClick={() => void save()}
                  type="button"
                >
                  Try again
                </button>
              </div>
            ) : null}
            <div className="mt-6 flex flex-col gap-3 border-t border-[var(--border)] pt-4 sm:flex-row sm:justify-end">
              <button
                className="secondary-button w-full sm:w-auto"
                disabled={!changed || saving}
                onClick={() => {
                  setDraft(loaded.entries);
                  setSaveFailed(false);
                  setUsedDestination(null);
                }}
                type="button"
              >
                Cancel
              </button>
              <button
                className="primary-button w-full sm:w-auto"
                disabled={!changed || saving}
                onClick={() => void save()}
                type="button"
              >
                {saving ? 'Saving changes…' : 'Save changes'}
              </button>
            </div>
          </>
        )}
      </section>
      {dialog !== null && loaded !== null ? (
        <DeliveryDialog
          available={loaded.available}
          entry={dialog.index === null ? null : (draft[dialog.index] ?? null)}
          onClose={closeDialog}
          onRemove={() => {
            setDraft(draft.filter((_, index) => index !== dialog.index));
            setDialog(null);
            addButton.current?.focus();
          }}
          onSubmit={(entry) => {
            setDraft(
              dialog.index === null
                ? [...draft, entry]
                : draft.map((existing, index) =>
                    index === dialog.index ? entry : existing,
                  ),
            );
            closeDialog();
          }}
          taken={draft
            .filter((_, index) => index !== dialog.index)
            .map((entry) => entry.destination)}
        />
      ) : null}
    </section>
  );
}

function DeliveryDialog({
  available,
  entry,
  onClose,
  onRemove,
  onSubmit,
  taken,
}: {
  readonly available: readonly string[];
  readonly entry: AgentCredentialEntry | null;
  readonly onClose: () => void;
  readonly onRemove: () => void;
  readonly onSubmit: (entry: AgentCredentialEntry) => void;
  readonly taken: readonly string[];
}): ReactNode {
  const names =
    entry !== null && !available.includes(entry.credentialName)
      ? [entry.credentialName, ...available]
      : available;
  const [credentialName, setCredentialName] = useState(
    entry?.credentialName ?? names[0] ?? '',
  );
  const [delivery, setDelivery] = useState<CredentialDeliveryMethod>(
    entry?.delivery ?? 'environment',
  );
  const [destination, setDestination] = useState(entry?.destination ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const credentialSelect = useRef<HTMLSelectElement>(null);
  const destinationInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    credentialSelect.current?.focus();
  }, []);

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = destination.trim();
    const found = destinationProblem(delivery, trimmed, taken);
    if (found !== null) {
      setProblem(found);
      destinationInput.current?.focus();
      return;
    }
    onSubmit({
      builtIn: false,
      credentialName,
      delivery,
      destination: trimmed,
      needsAttention: false,
    });
  }

  return (
    <div
      aria-labelledby="delivery-dialog-title"
      aria-modal="true"
      className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 sm:items-center sm:p-5"
      onKeyDown={(event) => trapFocus(event, onClose)}
      role="dialog"
    >
      <form
        className="card w-full rounded-b-none sm:max-w-md sm:rounded-b-2xl"
        onSubmit={submit}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id="delivery-dialog-title">Give this agent a credential</h2>
          <button
            aria-label="Close"
            className="rounded-lg px-2 py-1 text-xl outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)]"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </div>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Choose the saved credential and how the agent receives it. Its value
          stays hidden.
        </p>
        <label className="auth-label" htmlFor="delivery-credential">
          Credential
        </label>
        <select
          className="auth-input"
          id="delivery-credential"
          onChange={(event) => setCredentialName(event.target.value)}
          ref={credentialSelect}
          value={credentialName}
        >
          {names.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <fieldset className="mt-4 space-y-2">
          <legend className="sr-only">How the agent receives it</legend>
          {(['environment', 'file'] as const).map((method) => (
            <label className="flex items-start gap-2" key={method}>
              <input
                aria-describedby={`delivery-${method}-help`}
                aria-labelledby={`delivery-${method}-label`}
                checked={delivery === method}
                className="mt-1"
                name="delivery-method"
                onChange={() => {
                  setDelivery(method);
                  setProblem(null);
                }}
                type="radio"
              />
              <span>
                <span className="font-bold" id={`delivery-${method}-label`}>
                  {deliveryLabel(method)}
                </span>
                <span
                  className="block text-sm text-[var(--muted)]"
                  id={`delivery-${method}-help`}
                >
                  {method === 'environment'
                    ? 'The agent receives this value under a variable name.'
                    : 'The agent receives a temporary file at a path you name.'}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="auth-label" htmlFor="delivery-destination">
          {delivery === 'environment' ? 'Variable name' : 'File path'}
        </label>
        <input
          aria-describedby={
            problem === null ? undefined : 'delivery-destination-error'
          }
          aria-invalid={problem !== null}
          autoComplete="off"
          className="auth-input"
          id="delivery-destination"
          onChange={(event) => {
            setDestination(event.target.value);
            setProblem(null);
          }}
          ref={destinationInput}
          spellCheck={false}
          value={destination}
        />
        {problem !== null ? (
          <p
            className="mt-2 text-sm text-[var(--danger)]"
            id="delivery-destination-error"
          >
            {problem}
          </p>
        ) : null}
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
          {entry !== null ? (
            <button
              className="secondary-button w-full text-[var(--danger)] sm:mr-auto sm:w-auto"
              onClick={onRemove}
              type="button"
            >
              Remove from this agent
            </button>
          ) : null}
          <button
            className="secondary-button w-full sm:w-auto"
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="primary-button w-full sm:w-auto"
            disabled={credentialName === '' || destination.trim() === ''}
            type="submit"
          >
            Add credential
          </button>
        </div>
      </form>
    </div>
  );
}
