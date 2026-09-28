import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  getEffectiveTheme,
  getStoredTheme,
  setStoredTheme,
  themeStorageKey,
  type ThemePreference,
  type ThemeStorageWriter,
} from './theme';
import {
  browserInstanceClient,
  type InstanceClient,
  type InstanceStatus,
} from './instance';

export interface ThemeMediaQuery {
  readonly matches: boolean;
  addEventListener(
    type: 'change',
    listener: (event: MediaQueryListEvent) => void,
  ): void;
  removeEventListener(
    type: 'change',
    listener: (event: MediaQueryListEvent) => void,
  ): void;
}

type ThemeStorage = ThemeStorageWriter & Pick<Storage, 'getItem'>;

interface AppProps {
  mediaQuery?: ThemeMediaQuery;
  storage?: ThemeStorage;
  instanceClient?: InstanceClient;
}

const preferences: ThemePreference[] = ['light', 'dark', 'system'];

const unavailableStorage: ThemeStorage = {
  getItem: () => {
    throw new Error('Storage is unavailable');
  },
  setItem: () => {
    throw new Error('Storage is unavailable');
  },
};

function getBrowserMediaQuery(): ThemeMediaQuery {
  return window.matchMedia('(prefers-color-scheme: dark)');
}

function getBrowserStorage(): ThemeStorage {
  try {
    return window.localStorage;
  } catch {
    return unavailableStorage;
  }
}

function getInitialPreference(storage: ThemeStorage): ThemePreference {
  try {
    return getStoredTheme(storage.getItem(themeStorageKey)).preference;
  } catch {
    return 'system';
  }
}

export function App({
  mediaQuery = getBrowserMediaQuery(),
  storage = getBrowserStorage(),
  instanceClient = browserInstanceClient,
}: AppProps): ReactNode {
  const [preference, setPreference] = useState<ThemePreference>(() =>
    getInitialPreference(storage),
  );
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    mediaQuery.matches,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [instance, setInstance] = useState<InstanceStatus | null>(null);
  const [instanceError, setInstanceError] = useState<
    'not-running' | 'restart-failed' | null
  >(null);
  const [confirmingUpdate, setConfirmingUpdate] = useState(false);
  const [updating, setUpdating] = useState(false);
  const updateButton = useRef<HTMLButtonElement>(null);
  const items = useRef<Record<ThemePreference, HTMLDivElement | null>>({
    light: null,
    dark: null,
    system: null,
  });
  const effectiveTheme = getEffectiveTheme(preference, systemPrefersDark);

  useEffect(() => {
    const updateSystemPreference = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };

    mediaQuery.addEventListener('change', updateSystemPreference);
    return () =>
      mediaQuery.removeEventListener('change', updateSystemPreference);
  }, [mediaQuery]);

  useEffect(() => {
    document.documentElement.dataset.theme = effectiveTheme;
  }, [effectiveTheme]);

  useEffect(() => {
    if (menuOpen) {
      const timer = window.setTimeout(() => {
        items.current[preference]?.focus();
      });

      return () => window.clearTimeout(timer);
    }

    return undefined;
  }, [menuOpen, preference]);

  const refreshInstance = async () => {
    try {
      const nextInstance = await instanceClient.getStatus();
      setInstance(nextInstance);
      setInstanceError(null);
    } catch {
      setInstance(null);
      setInstanceError('not-running');
    }
  };

  useEffect(() => {
    void refreshInstance();
  }, [instanceClient]);

  async function updateInstance(): Promise<void> {
    setConfirmingUpdate(false);
    setUpdating(true);
    try {
      await instanceClient.update();
      await refreshInstance();
    } catch {
      setInstance(null);
      setInstanceError('restart-failed');
    } finally {
      setUpdating(false);
    }
  }

  function choosePreference(
    nextPreference: ThemePreference,
    event: Event,
  ): void {
    setPreference(nextPreference);
    const result = setStoredTheme(storage, nextPreference);

    if (result.ok) {
      setSaveError(false);
      return;
    }

    event.preventDefault();
    setSaveError(true);
    setMenuOpen(true);
  }

  return (
    <div className="min-h-screen bg-[var(--page)] text-[var(--foreground)]">
      <header className="flex h-[4.5rem] items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-5 sm:px-[5vw]">
        <span className="text-lg font-bold tracking-tight sm:text-xl">
          Cerebra
        </span>
        <DropdownMenu.Root
          onOpenChange={(open) => {
            setMenuOpen(open);
            if (!open) {
              setSaveError(false);
            }
          }}
          open={menuOpen}
        >
          <DropdownMenu.Trigger asChild>
            <button
              aria-label={`Theme: ${preference[0].toUpperCase() + preference.slice(1)}`}
              className="rounded-lg border border-[var(--control-border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm font-medium shadow-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-[var(--focus)] motion-reduce:transition-none sm:text-base"
              type="button"
            >
              <span className="sr-only sm:not-sr-only">Theme: </span>
              {preference[0].toUpperCase() + preference.slice(1)}
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              className="z-10 mt-2 w-65 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-xl outline-none"
              sideOffset={8}
            >
              <DropdownMenu.Label className="px-2.5 py-1.5 text-xs font-bold text-[var(--muted)]">
                Appearance
              </DropdownMenu.Label>
              <DropdownMenu.RadioGroup value={preference}>
                {preferences.map((choice) => (
                  <DropdownMenu.RadioItem
                    className="relative flex w-full cursor-default select-none items-center rounded-lg px-2.5 py-2.5 text-left text-sm outline-none data-[highlighted]:bg-[var(--accent-muted)] data-[state=checked]:font-bold data-[state=checked]:text-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                    key={choice}
                    onSelect={(event) => choosePreference(choice, event)}
                    ref={(element) => {
                      items.current[choice] = element;
                    }}
                    value={choice}
                  >
                    {choice[0].toUpperCase() + choice.slice(1)}
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
              {saveError ? (
                <p
                  className="px-2.5 pb-1.5 pt-2 text-xs font-semibold leading-snug text-[var(--danger)]"
                  role="alert"
                >
                  Cerebra couldn’t save that appearance choice. It will reset
                  when you close this page.
                </p>
              ) : null}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </header>
      <main className="mx-auto w-full max-w-255 px-5 py-10 sm:py-14">
        <p className="text-xs font-extrabold uppercase tracking-widest text-[var(--accent)]">
          This Mac
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
          Manage Cerebra
        </h1>
        <p className="mt-1 text-[var(--muted)]">
          Your private workspace is available only on this computer.
        </p>
        {instance === null && instanceError !== 'restart-failed' ? (
          <section className="mt-7 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm">
            <h2 className="text-lg font-bold">Cerebra isn’t running</h2>
            <p className="mt-2 text-[var(--muted)]">
              Start Cerebra, then try again.
            </p>
            <code className="mt-4 block rounded-lg bg-slate-900 p-3 text-sm text-slate-100">
              ./cerebra start
            </code>
            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <button
                className="primary-button"
                onClick={() => void refreshInstance()}
                type="button"
              >
                Try again
              </button>
              <button className="secondary-button" type="button">
                View setup help
              </button>
            </div>
          </section>
        ) : instanceError === 'restart-failed' ? (
          <section className="mt-7 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm">
            <h2 className="text-lg font-bold text-[var(--danger)]">
              Cerebra couldn’t restart
            </h2>
            <p className="mt-2 text-[var(--muted)]">
              Your data is still safe. Read the update details, then try again.
            </p>
            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <button
                className="primary-button"
                onClick={() => void refreshInstance()}
                type="button"
              >
                Try again
              </button>
              <button className="secondary-button" type="button">
                View update details
              </button>
            </div>
          </section>
        ) : (
          <div className="mt-7 grid gap-5 lg:grid-cols-[1.35fr_.85fr]">
            <section className="card">
              <h2>Instance status</h2>
              <p className="mt-3 font-bold text-emerald-700 dark:text-emerald-300">
                Running
              </p>
              <p className="mt-1 text-[var(--muted)]">
                Cerebra is ready at{' '}
                <strong>{instance?.address ?? 'http://localhost:4317'}</strong>.
              </p>
              <div className="mt-6 grid gap-4 border-t border-[var(--border)] pt-5 sm:grid-cols-2">
                <p>
                  <strong>Data</strong>
                  <br />
                  <span className="text-sm text-[var(--muted)]">
                    Stored locally
                  </span>
                </p>
                <p>
                  <strong>Last updated</strong>
                  <br />
                  <span className="text-sm text-[var(--muted)]">
                    {instance
                      ? new Date(instance.lastUpdatedAt).toLocaleString()
                      : 'Loading…'}
                  </span>
                </p>
              </div>
              <a
                className="primary-button mt-5 inline-block"
                href={instance?.address ?? 'http://localhost:4317'}
              >
                Open Cerebra
              </a>
            </section>
            <section className="card">
              <h2>Get started</h2>
              <ol className="mt-3 space-y-4 text-sm text-[var(--muted)]">
                <li>
                  <strong className="block text-[var(--foreground)]">
                    1. Install Podman
                  </strong>
                  Set up the local container service.
                </li>
                <li>
                  <strong className="block text-[var(--foreground)]">
                    2. Start Cerebra
                  </strong>
                  Run one command from the Cerebra folder.
                </li>
                <li>
                  <strong className="block text-[var(--foreground)]">
                    3. Choose a password
                  </strong>
                  Then add your first project.
                </li>
              </ol>
              <button className="secondary-button mt-5" type="button">
                View setup steps
              </button>
            </section>
          </div>
        )}
        <section className="card mt-5">
          <h2>Update Cerebra</h2>
          <p className="mt-2 text-[var(--muted)]">
            Get the latest version when you are ready.
          </p>
          <p className="mt-5 rounded-lg border-l-4 border-amber-500 bg-amber-50 p-4 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-50">
            <strong>Running work will stop.</strong> Updating restarts Cerebra.
            Work that was still running returns to its queue and can be started
            again.
          </p>
          <button
            ref={updateButton}
            className="primary-button mt-5"
            disabled={updating}
            onClick={() => setConfirmingUpdate(true)}
            type="button"
          >
            Update and restart
          </button>
        </section>
        {confirmingUpdate ? (
          <div
            aria-labelledby="update-title"
            aria-modal="true"
            className="fixed inset-0 grid place-items-center bg-black/40 p-5"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setConfirmingUpdate(false);
                updateButton.current?.focus();
              }
              if (event.key === 'Tab') {
                const buttons = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    'button',
                  ),
                );
                const first = buttons[0];
                const last = buttons.at(-1);
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first?.focus();
                }
              }
            }}
            role="dialog"
          >
            <section className="card w-full max-w-md">
              <h2 id="update-title">Update Cerebra?</h2>
              <p className="mt-3 text-[var(--muted)]">
                The latest version will be installed and Cerebra will restart.
              </p>
              <p className="mt-3 text-sm text-[var(--muted)]">
                <strong>Running work will stop.</strong> Work that was still
                running returns to its queue and can be started again.
              </p>
              <div className="mt-6 flex gap-3">
                <button
                  autoFocus
                  className="secondary-button"
                  onClick={() => {
                    setConfirmingUpdate(false);
                    updateButton.current?.focus();
                  }}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  className="primary-button"
                  onClick={() => void updateInstance()}
                  type="button"
                >
                  Update and restart
                </button>
              </div>
            </section>
          </div>
        ) : null}
      </main>
    </div>
  );
}
