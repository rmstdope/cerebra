import { useCallback, useEffect, useState, type ReactNode } from 'react';

import {
  aboveCeilingMessage,
  browserAutomaticStartsClient,
  LimitRequestError,
  parseLimit,
  type AutomaticStartsClient,
  type Limits,
} from './automatic-starts';

function LimitForm({
  ceiling,
  help,
  id,
  label,
  onSave,
  saved,
  title,
}: {
  readonly ceiling: number | null;
  readonly help: string | null;
  readonly id: string;
  readonly label: string;
  readonly onSave: (value: number) => Promise<void>;
  readonly saved: number;
  readonly title: string;
}): ReactNode {
  const [text, setText] = useState(String(saved));
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const save = async () => {
    setNotice(null);
    setSaveFailed(false);
    const value = parseLimit(text);
    if (typeof value !== 'number') {
      setFieldError(value.error);
      return;
    }
    if (ceiling !== null && value > ceiling) {
      setFieldError(aboveCeilingMessage(ceiling));
      return;
    }
    setFieldError(null);
    setSaving(true);
    try {
      await onSave(value);
      setText(String(value));
      setNotice('Saved.');
    } catch (error) {
      if (error instanceof LimitRequestError && error.invalid) {
        setFieldError(error.message);
      } else {
        setSaveFailed(true);
      }
    } finally {
      setSaving(false);
    }
  };

  const describedBy = [help === null ? null : `${id}-help`, `${id}-error`]
    .filter((value) => value !== null)
    .join(' ');

  return (
    <form
      aria-labelledby={`${id}-heading`}
      className="card"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h2 className="text-lg font-bold" id={`${id}-heading`}>
        {title}
      </h2>
      {saveFailed ? (
        <p className="auth-error" role="alert">
          Cerebra couldn’t save this limit. Nothing has changed. Try again.
        </p>
      ) : null}
      <label className="auth-label" htmlFor={id}>
        {label}
      </label>
      <input
        aria-describedby={describedBy}
        aria-invalid={fieldError !== null}
        autoComplete="off"
        className="auth-input sm:max-w-40"
        id={id}
        inputMode="numeric"
        onChange={(event) => {
          setText(event.target.value);
          setNotice(null);
        }}
        value={text}
      />
      {help === null ? null : (
        <p className="mt-1 text-sm text-[var(--muted)]" id={`${id}-help`}>
          {help}
        </p>
      )}
      <p
        className="mt-1 text-sm text-[var(--danger)] empty:hidden"
        id={`${id}-error`}
      >
        {fieldError}
      </p>
      <p aria-live="polite" className="mt-2 text-sm empty:hidden" role="status">
        {notice}
      </p>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
        <button
          className="secondary-button w-full sm:w-auto"
          onClick={() => {
            setText(String(saved));
            setFieldError(null);
            setSaveFailed(false);
            setNotice(null);
          }}
          type="button"
        >
          Cancel
        </button>
        <button
          className="primary-button w-full sm:w-auto"
          disabled={saving}
          type="submit"
        >
          Save changes
        </button>
      </div>
    </form>
  );
}

/** How much work runs at once, in this project and across Cerebra (spec §5.4). */
export function LimitsPage({
  client = browserAutomaticStartsClient,
  projectId,
}: {
  readonly client?: AutomaticStartsClient;
  readonly projectId: string | null;
}): ReactNode {
  const [limits, setLimits] = useState<Limits | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setLimits(await client.limits(projectId));
    } catch {
      setFailed(true);
    }
  }, [client, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-labelledby="limits-heading">
      <h1
        className="text-3xl font-bold tracking-tight sm:text-4xl"
        id="limits-heading"
      >
        Limits
      </h1>
      <p className="mt-1 text-[var(--muted)]">
        How much work Cerebra starts on its own at once.
      </p>
      {failed ? (
        <p className="auth-error" role="alert">
          Cerebra couldn’t load the limits.{' '}
          <button
            className="font-bold underline"
            onClick={() => void load()}
            type="button"
          >
            Try again
          </button>
        </p>
      ) : limits === null ? (
        <div
          aria-busy="true"
          className="mt-8 h-40 animate-pulse rounded-lg bg-[var(--accent-muted)] motion-reduce:animate-none"
        >
          <span className="sr-only">Loading…</span>
        </div>
      ) : (
        <div className="mt-8 grid gap-5">
          {projectId !== null && limits.projectLimit !== null ? (
            <LimitForm
              ceiling={limits.instanceLimit}
              help={`Cerebra-wide limit is ${limits.instanceLimit}.`}
              id="project-limit"
              label="Work running at once in this project"
              onSave={async (value) => {
                setLimits(await client.saveProjectLimit(projectId, value));
              }}
              saved={limits.projectLimit}
              title="This project"
            />
          ) : null}
          <LimitForm
            ceiling={null}
            help={null}
            id="instance-limit"
            label="Work running at once across all projects"
            onSave={async (value) => {
              const next = await client.saveInstanceLimit(value);
              setLimits((current) => ({
                instanceLimit: next.instanceLimit,
                projectLimit: current?.projectLimit ?? null,
              }));
            }}
            saved={limits.instanceLimit}
            title="All projects"
          />
        </div>
      )}
    </section>
  );
}
