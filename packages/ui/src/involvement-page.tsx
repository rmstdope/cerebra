import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  browserInvolvementClient,
  InvolvementRequestError,
  type Involvement,
  type InvolvementClient,
  type InvolvementSetting,
} from './involvement';

const presets: readonly {
  readonly value: Involvement;
  readonly title: string;
  readonly description: string;
}[] = [
  {
    value: 'autonomous',
    title: 'Autonomous',
    description:
      'Builders plan, build and merge on their own. The reviewer agent still reviews everything.',
  },
  {
    value: 'plan',
    title: 'Approve plans',
    description:
      'Each builder waits for you to approve its plan before writing code.',
  },
  {
    value: 'full',
    title: 'Approve plans and code',
    description:
      'You also review every pull request on GitHub before it merges.',
  },
];

const missingAccount = 'Enter the GitHub account whose review counts.';

function InvolvementForm({
  onSave,
  saved,
}: {
  readonly onSave: (setting: InvolvementSetting) => Promise<void>;
  readonly saved: InvolvementSetting;
}): ReactNode {
  const [choice, setChoice] = useState<Involvement>(saved.involvement);
  const [account, setAccount] = useState(saved.reviewAccount ?? '');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const accountInput = useRef<HTMLInputElement>(null);
  const focusAccount = useRef(false);

  useEffect(() => {
    if (focusAccount.current) {
      focusAccount.current = false;
      accountInput.current?.focus();
    }
  }, [choice]);

  const save = async () => {
    setNotice(null);
    setSaveFailed(false);
    const trimmed = account.trim();
    if (choice === 'full' && trimmed === '') {
      setFieldError(missingAccount);
      accountInput.current?.focus();
      return;
    }
    setFieldError(null);
    setSaving(true);
    try {
      await onSave({
        involvement: choice,
        reviewAccount: trimmed === '' ? null : trimmed,
      });
      setNotice('Saved.');
    } catch (error) {
      if (error instanceof InvolvementRequestError && error.invalid) {
        setFieldError(error.message);
      } else {
        setSaveFailed(true);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      aria-labelledby="involvement-heading"
      className="card mt-8"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div
        aria-labelledby="involvement-heading"
        className="grid gap-3"
        role="radiogroup"
      >
        {presets.map((preset) => {
          const selected = choice === preset.value;
          const id = `involvement-${preset.value}`;
          return (
            <div
              className={`rounded-lg border-2 p-4 ${
                selected
                  ? 'border-[var(--accent)] bg-[var(--accent-muted)]'
                  : 'border-[var(--border)]'
              }`}
              key={preset.value}
            >
              <label className="flex cursor-pointer gap-3" htmlFor={id}>
                <input
                  aria-describedby={`${id}-description`}
                  aria-labelledby={`${id}-title`}
                  checked={selected}
                  className="mt-1 size-4 accent-[var(--accent)]"
                  id={id}
                  name="involvement"
                  onChange={() => {
                    setChoice(preset.value);
                    setNotice(null);
                    setFieldError(null);
                    focusAccount.current =
                      preset.value === 'full' && account.trim() === '';
                  }}
                  type="radio"
                  value={preset.value}
                />
                <span>
                  <span className="font-bold" id={`${id}-title`}>
                    {preset.title}
                  </span>
                  <span
                    className="mt-1 block text-sm text-[var(--muted)]"
                    id={`${id}-description`}
                  >
                    {preset.description}
                  </span>
                </span>
              </label>
              {preset.value === 'full' && selected ? (
                <div className="mt-4 sm:ml-7">
                  <label className="auth-label" htmlFor="review-account">
                    Your GitHub account for reviews
                  </label>
                  <input
                    aria-describedby="review-account-help review-account-error"
                    aria-invalid={fieldError !== null}
                    autoComplete="off"
                    className="auth-input sm:max-w-80"
                    id="review-account"
                    onChange={(event) => {
                      setAccount(event.target.value);
                      setNotice(null);
                    }}
                    ref={accountInput}
                    spellCheck={false}
                    value={account}
                  />
                  <p
                    className="mt-1 text-sm text-[var(--muted)]"
                    id="review-account-help"
                  >
                    Only a review from this account counts.
                  </p>
                  <p
                    className="mt-1 text-sm text-[var(--danger)] empty:hidden"
                    id="review-account-error"
                  >
                    {fieldError}
                  </p>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-sm text-[var(--muted)]">
        Changes apply the next time a builder reaches a plan or a review. Work
        already waiting for you stays waiting.
      </p>
      {saveFailed ? (
        <p className="auth-error" role="alert">
          Settings weren't saved. Try again.
        </p>
      ) : null}
      <p aria-live="polite" className="mt-2 text-sm empty:hidden" role="status">
        {notice}
      </p>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-end">
        <button
          className="primary-button w-full sm:w-auto"
          disabled={saving}
          type="submit"
        >
          Save
        </button>
      </div>
    </form>
  );
}

/** How closely the navigator follows this project's builders (spec §4.9, D32). */
export function InvolvementPage({
  client = browserInvolvementClient,
  projectId,
}: {
  readonly client?: InvolvementClient;
  readonly projectId: string | null;
}): ReactNode {
  const [setting, setSetting] = useState<InvolvementSetting | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (projectId === null) return;
    setFailed(false);
    try {
      setSetting(await client.get(projectId));
    } catch {
      setFailed(true);
    }
  }, [client, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section aria-labelledby="involvement-heading">
      <h1
        className="text-3xl font-bold tracking-tight sm:text-4xl"
        id="involvement-heading"
      >
        How closely you follow the builders
      </h1>
      {projectId === null ? (
        <p className="card mt-8">
          Add a project first, then choose how closely you follow its builders.
        </p>
      ) : failed ? (
        <p className="auth-error" role="alert">
          Cerebra couldn’t load this setting.{' '}
          <button
            className="font-bold underline"
            onClick={() => void load()}
            type="button"
          >
            Try again
          </button>
        </p>
      ) : setting === null ? (
        <div
          aria-busy="true"
          className="mt-8 h-60 animate-pulse rounded-lg bg-[var(--accent-muted)] motion-reduce:animate-none"
        >
          <span className="sr-only">Loading…</span>
        </div>
      ) : (
        <InvolvementForm
          onSave={async (next) => {
            setSetting(await client.save(projectId, next));
          }}
          saved={setting}
        />
      )}
    </section>
  );
}
