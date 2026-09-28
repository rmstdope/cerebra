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
}

const preferences: ThemePreference[] = ['light', 'dark', 'system'];

function getBrowserMediaQuery(): ThemeMediaQuery {
  return window.matchMedia('(prefers-color-scheme: dark)');
}

function getBrowserStorage(): ThemeStorage {
  return window.localStorage;
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
}: AppProps): ReactNode {
  const [preference, setPreference] = useState<ThemePreference>(() =>
    getInitialPreference(storage),
  );
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    mediaQuery.matches,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [saveError, setSaveError] = useState(false);
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
                <p className="px-2.5 pb-1.5 pt-2 text-xs font-semibold leading-snug text-[var(--danger)]">
                  Cerebra couldn’t save that appearance choice. It will reset
                  when you close this page.
                </p>
              ) : null}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </header>
      <main className="mx-auto w-full max-w-190 px-5 pb-15 pt-24 text-center sm:pt-30">
        <div
          aria-hidden="true"
          className="mx-auto mb-6 grid size-14 place-items-center rounded-2xl bg-[var(--accent-muted)] text-2xl text-[var(--accent)]"
        >
          ✦
        </div>
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          Welcome to Cerebra
        </h1>
        <p className="mx-auto mt-5 max-w-150 text-base leading-relaxed text-[var(--muted)] sm:text-lg">
          There is nothing to review yet. Add your first project to start
          organising work here.
        </p>
        <section className="mx-auto mt-10 max-w-190 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-6 py-5 text-left shadow-sm">
          <h2 className="text-sm font-bold">No projects have been added</h2>
          <p className="mt-1 text-sm leading-relaxed text-[var(--muted)]">
            Your projects and any work waiting for you will appear in this
            space.
          </p>
        </section>
      </main>
    </div>
  );
}
