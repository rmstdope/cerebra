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
  AuthenticationRequiredError,
  browserInstanceClient,
  type InstanceClient,
  type InstanceStatus,
} from './instance';
import {
  AuthRequestError,
  browserAuthClient,
  type AuthClient,
  type AuthStatus,
} from './auth';
import { ProjectRegistration } from './project-registration';
import {
  browserProjectClient,
  type ProjectClient,
  type ProjectDirectoryClient,
  type RegisteredProject,
} from './projects';
import type { BoardClient } from './board';
import type { AutomaticStartsClient } from './automatic-starts';
import type { BackupsClient } from './backups';
import { BackupsPage } from './backups-page';
import { LimitsPage } from './limits-page';
import { NavigatorQueue, type WorkTab } from './navigator-queue';
import { ProjectBoard } from './project-board';
import type { FleetClient } from './fleet';
import { ConversationPage } from './conversation-page';
import { FleetPage } from './fleet-page';
import { browserFleetClient } from './fleet';
import { browserConversationClient, type ConversationClient } from './runs';
import type { QueueClient } from './queue';
import { AgentCredentialsPage, AgentTypesList } from './agent-credentials';
import type { CredentialClient } from './credentials';
import { CredentialsPage } from './credentials-page';
import { AttentionCenter } from './attention-center';
import {
  browserAttentionClient,
  type AttentionClient,
  type AttentionEntry,
} from './attention';
import type { CostClient } from './costs';
import type { NotificationSettingsClient } from './notification-settings';
import { NotificationSettingsPage } from './notification-settings-page';
import {
  connectNotifications,
  type ConnectNotificationsOptions,
} from './notifications';

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
  authClient?: AuthClient;
  boardClient?: BoardClient;
  automaticStartsClient?: AutomaticStartsClient;
  backupsClient?: BackupsClient;
  fleetClient?: FleetClient;
  queueClient?: QueueClient;
  credentialClient?: CredentialClient;
  conversationClient?: ConversationClient;
  projectClient?: ProjectClient;
  projectDirectoryClient?: ProjectDirectoryClient;
  attentionClient?: AttentionClient;
  costClient?: CostClient;
  notificationSettingsClient?: NotificationSettingsClient;
  /** Opens the push connection; returns what closes it. */
  notificationsConnector?: (
    options: Pick<
      ConnectNotificationsOptions,
      'onOpenEntry' | 'onOpenPanel' | 'onPush'
    >,
  ) => () => void;
}

type SettingsRoute =
  | { readonly page: 'credentials' }
  | { readonly page: 'agents' }
  | { readonly page: 'limits' }
  | { readonly page: 'notifications' }
  | { readonly page: 'backups' }
  | { readonly page: 'agent'; readonly agentType: string };

function conversationRoute(hash: string): string | null {
  return /^#\/conversations\/([0-9a-f-]+)$/i.exec(hash)?.[1] ?? null;
}

function settingsRoute(hash: string): SettingsRoute | null {
  if (hash === '#/settings' || hash === '#/settings/credentials') {
    return { page: 'credentials' };
  }
  if (hash === '#/settings/agents') {
    return { page: 'agents' };
  }
  if (hash === '#/settings/limits') {
    return { page: 'limits' };
  }
  if (hash === '#/settings/notifications') {
    return { page: 'notifications' };
  }
  if (hash === '#/settings/backups') {
    return { page: 'backups' };
  }
  const agent = /^#\/settings\/agents\/([a-z][a-z0-9-]*)$/.exec(hash);
  return agent === null ? null : { agentType: agent[1], page: 'agent' };
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
  authClient = browserAuthClient,
  boardClient,
  automaticStartsClient,
  backupsClient,
  fleetClient,
  queueClient,
  credentialClient,
  conversationClient = browserConversationClient,
  projectClient = browserProjectClient,
  projectDirectoryClient = browserProjectClient,
  attentionClient = browserAttentionClient,
  costClient,
  notificationSettingsClient,
  notificationsConnector = connectNotifications,
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
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [authUnavailable, setAuthUnavailable] = useState(false);
  const [instanceError, setInstanceError] = useState<
    'not-running' | 'restart-failed' | null
  >(null);
  const [confirmingUpdate, setConfirmingUpdate] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(() => {
    try {
      return storage.getItem('cerebra.project') || null;
    } catch {
      return null;
    }
  });
  const [projects, setProjects] = useState<readonly RegisteredProject[] | null>(
    null,
  );
  const [projectLoadError, setProjectLoadError] = useState(false);
  const [projectLoading, setProjectLoading] = useState(true);
  const [projectReload, setProjectReload] = useState(0);
  const [projectSaveError, setProjectSaveError] = useState(false);
  const [addingProject, setAddingProject] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const [boardRequest, setBoardRequest] = useState<{
    readonly id: string;
    readonly tab: WorkTab;
  } | null>(null);
  const [projectView, setProjectView] = useState<'board' | 'fleet'>('board');
  const [returnToFleet, setReturnToFleet] = useState(false);
  const [hash, setHash] = useState(() => window.location.hash);
  const [attentionPush, setAttentionPush] = useState(0);
  const [attentionOpen, setAttentionOpen] = useState(0);
  const [queueRequest, setQueueRequest] = useState<{
    readonly id: string;
  } | null>(null);
  const focusQueue = useRef(false);
  const focusBackups = useRef(false);
  const settings = settingsRoute(hash);
  const conversation = settings === null ? conversationRoute(hash) : null;
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
    const followHash = () => {
      setHash(window.location.hash);
      if (window.location.hash !== '') setQueueRequest(null);
    };
    window.addEventListener('hashchange', followHash);
    return () => window.removeEventListener('hashchange', followHash);
  }, []);

  useEffect(() => {
    if (settings === null && focusQueue.current) {
      focusQueue.current = false;
      document.getElementById('navigator-queue-heading')?.focus();
    }
    if (settings?.page === 'backups' && focusBackups.current) {
      focusBackups.current = false;
      document.getElementById('backups-heading')?.focus();
    }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = effectiveTheme;
  }, [effectiveTheme]);

  useEffect(() => {
    document.title = queueCount > 0 ? `(${queueCount}) Cerebra` : 'Cerebra';
  }, [queueCount]);

  useEffect(() => {
    void authClient
      .status()
      .then((status) => {
        setAuthStatus(status);
        setAuthUnavailable(false);
      })
      .catch(() => {
        setAuthStatus({ state: 'unauthenticated', reason: 'signed-out' });
        setAuthUnavailable(true);
      });
  }, [authClient]);

  useEffect(() => {
    if (authStatus?.state !== 'authenticated') return;
    let cancelled = false;
    setProjectLoading(true);
    void projectDirectoryClient
      .list()
      .then((loaded) => {
        if (cancelled) return;
        setProjects(loaded);
        setProjectId((current) =>
          loaded.some((project) => project.id === current) ? current : null,
        );
        setProjectLoadError(false);
        setProjectLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setProjectLoadError(true);
        setProjectLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authStatus?.state, projectDirectoryClient, projectReload]);

  function openAttentionEntry(entry: AttentionEntry): void {
    if (entry.runId !== null) {
      window.location.hash = `#/conversations/${entry.runId}`;
      return;
    }
    window.history.pushState(
      null,
      '',
      window.location.pathname + window.location.search,
    );
    setHash('');
    setQueueRequest({ id: entry.itemId ?? entry.id });
  }
  const openEntry = useRef(openAttentionEntry);
  openEntry.current = openAttentionEntry;

  useEffect(() => {
    if (authStatus?.state !== 'authenticated') return;
    return notificationsConnector({
      onOpenEntry: (entry) => openEntry.current(entry),
      onOpenPanel: () => setAttentionOpen((count) => count + 1),
      onPush: () => setAttentionPush((count) => count + 1),
    });
  }, [authStatus?.state, notificationsConnector]);

  function rememberProject(id: string): void {
    setProjectId(id);
    try {
      storage.setItem('cerebra.project', id);
      setProjectSaveError(false);
    } catch {
      setProjectSaveError(true);
    }
  }

  function openProject(id: string): void {
    rememberProject(id);
    setAddingProject(false);
    setProjectView('board');
    setReturnToFleet(false);
    setBoardRequest(null);
    if (conversation !== null) {
      window.location.hash = '';
      setHash('');
    }
  }

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
    } catch (error) {
      if (error instanceof AuthenticationRequiredError) {
        setAuthStatus({ state: 'unauthenticated', reason: error.reason });
        return;
      }
      setInstance(null);
      setInstanceError('not-running');
    }
  };

  useEffect(() => {
    if (authStatus?.state !== 'authenticated') {
      return;
    }
    void refreshInstance();
  }, [authStatus?.state, instanceClient]);

  if (authStatus?.state !== 'authenticated') {
    return (
      <AccessPanel
        authClient={authClient}
        initialMode={authStatus?.state === 'setup' ? 'setup' : 'sign-in'}
        initialUnavailable={authUnavailable}
        expired={
          authStatus?.state === 'unauthenticated' &&
          authStatus.reason === 'expired'
        }
        onAuthenticated={() => {
          setAuthStatus({ state: 'authenticated' });
          setAuthUnavailable(false);
        }}
      />
    );
  }

  function AccessPanel({
    authClient,
    expired,
    initialMode,
    initialUnavailable,
    onAuthenticated,
  }: {
    readonly authClient: AuthClient;
    readonly expired: boolean;
    readonly initialMode: 'setup' | 'sign-in';
    readonly initialUnavailable: boolean;
    readonly onAuthenticated: () => void;
  }): ReactNode {
    const [mode, setMode] = useState(initialMode);
    const [password, setPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<
      'rejected' | 'service' | 'expired' | null
    >(expired ? 'expired' : initialUnavailable ? 'service' : null);
    const passwordInput = useRef<HTMLInputElement>(null);
    const isSetup = mode === 'setup';
    const passwordValid = password.length >= 8;
    const confirmationMatches = password === confirmation;
    const canSubmit =
      !submitting &&
      password.length > 0 &&
      (!isSetup || (passwordValid && confirmationMatches));

    useEffect(() => {
      passwordInput.current?.focus();
    }, [error, mode]);

    useEffect(() => {
      setMode(initialMode);
      setError(expired ? 'expired' : initialUnavailable ? 'service' : null);
    }, [expired, initialMode, initialUnavailable]);

    async function submit(
      event: React.FormEvent<HTMLFormElement>,
    ): Promise<void> {
      event.preventDefault();
      if (!canSubmit) {
        return;
      }

      setSubmitting(true);
      setError(null);
      try {
        if (isSetup) {
          await authClient.setup(password);
        } else {
          await authClient.signIn(password);
        }
        setPassword('');
        setConfirmation('');
        onAuthenticated();
      } catch (caught) {
        const requestError =
          caught instanceof AuthRequestError
            ? caught
            : new AuthRequestError(
                'Cerebra couldn’t sign you in. Check that it is running, then try again.',
                'service',
              );
        if (requestError.reason === 'rejected-password') {
          setPassword('');
          setError('rejected');
        } else {
          setError('service');
        }
      } finally {
        setSubmitting(false);
      }
    }

    return (
      <main className="mx-auto flex min-h-screen w-full max-w-225 items-center px-5 py-8">
        <section className="grid w-full overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-sm md:grid-cols-2">
          <aside className="bg-[var(--accent-muted)] p-8 md:p-12">
            <div
              aria-hidden="true"
              className="grid size-13 place-items-center rounded-2xl bg-[var(--surface)] text-2xl text-[var(--accent)]"
            >
              *
            </div>
            <h1 className="mt-6 text-3xl font-bold tracking-tight">
              Your work, in one private place.
            </h1>
            <p className="mt-4 leading-relaxed text-[var(--muted)]">
              Return to the board, conversations and decisions that keep your
              projects moving.
            </p>
            <p className="mt-8 border-t border-[var(--border)] pt-5 text-sm font-medium text-[var(--muted)]">
              Private to this computer
            </p>
          </aside>
          <form
            className="p-8 md:p-12"
            onSubmit={(event) => void submit(event)}
          >
            <h2 className="text-2xl font-bold tracking-tight">
              {isSetup
                ? 'Protect Cerebra'
                : error === 'expired'
                  ? 'Sign in to continue'
                  : 'Sign in'}
            </h2>
            <p className="mt-2 text-[var(--muted)]">
              {isSetup
                ? 'Create a password before you begin.'
                : 'Enter your password to continue.'}
            </p>
            {error === 'rejected' ? (
              <p className="auth-error" role="alert">
                That password didn’t match. Try again.
              </p>
            ) : error === 'expired' ? (
              <p className="auth-error auth-expired" role="alert">
                For your security, please enter your password again.
              </p>
            ) : error === 'service' ? (
              <p className="auth-error" role="alert">
                Cerebra couldn’t sign you in. Check that it is running, then try
                again.
              </p>
            ) : null}
            <label className="auth-label" htmlFor="password">
              Password
            </label>
            <input
              aria-invalid={isSetup && !passwordValid && password.length > 0}
              className="auth-input"
              id="password"
              onChange={(event) => setPassword(event.target.value)}
              ref={passwordInput}
              type="password"
              value={password}
            />
            {isSetup ? (
              <p className="mt-2 text-sm text-[var(--muted)]">
                Use at least 8 characters.
              </p>
            ) : null}
            {isSetup ? (
              <>
                <label className="auth-label" htmlFor="confirmation">
                  Confirm password
                </label>
                <input
                  aria-invalid={confirmation.length > 0 && !confirmationMatches}
                  className="auth-input"
                  id="confirmation"
                  onChange={(event) => setConfirmation(event.target.value)}
                  type="password"
                  value={confirmation}
                />
                {confirmation.length > 0 && !confirmationMatches ? (
                  <p className="mt-2 text-sm text-[var(--danger)]">
                    Passwords don’t match.
                  </p>
                ) : null}
              </>
            ) : null}
            <button
              className="primary-button mt-6 w-full"
              disabled={!canSubmit}
              type="submit"
            >
              {submitting
                ? isSetup
                  ? 'Creating password…'
                  : 'Signing in…'
                : isSetup
                  ? 'Create password'
                  : 'Sign in'}
            </button>
            {!isSetup ? (
              <p className="mt-5 text-sm text-[var(--muted)]">
                You’ll stay signed in here until you sign out.
              </p>
            ) : null}
          </form>
        </section>
      </main>
    );
  }

  async function updateInstance(): Promise<void> {
    setConfirmingUpdate(false);
    setUpdating(true);
    try {
      await instanceClient.update();
      await refreshInstance();
    } catch (error) {
      if (error instanceof AuthenticationRequiredError) {
        setAuthStatus({ state: 'unauthenticated', reason: error.reason });
        return;
      }
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
        <a
          className="mr-2 ml-auto flex items-center gap-2 rounded-lg px-2 py-2 text-sm font-bold outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)] sm:text-base"
          href="#navigator-queue-heading"
          onClick={(event) => {
            event.preventDefault();
            if (settings !== null) {
              focusQueue.current = true;
              window.history.pushState(
                null,
                '',
                window.location.pathname + window.location.search,
              );
              setHash('');
              return;
            }
            document.getElementById('navigator-queue-heading')?.focus();
          }}
        >
          Navigator queue{' '}
          {queueCount > 0 ? (
            <span className="inline-grid min-w-6 place-items-center rounded-full bg-[var(--accent)] px-2 py-0.5 text-xs text-white dark:text-slate-950">
              {queueCount}
            </span>
          ) : null}
        </a>
        <AttentionCenter
          client={attentionClient}
          closeKey={projectId ?? ''}
          onOpen={openAttentionEntry}
          onOpenSettings={() => {
            window.location.hash = '#/settings/notifications';
          }}
          openSignal={attentionOpen}
          pushSignal={attentionPush}
        />
        <a
          aria-current={settings !== null ? 'page' : undefined}
          className="mr-2 rounded-lg px-2 py-2 text-sm font-bold outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)] sm:text-base"
          href="#/settings/credentials"
        >
          Settings
        </a>
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
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              aria-label="Account"
              className="ml-2 rounded-lg border border-[var(--control-border)] bg-[var(--surface)] px-3.5 py-2.5 text-sm font-medium shadow-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-[var(--focus)] motion-reduce:transition-none sm:text-base"
              type="button"
            >
              Account
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              className="z-10 mt-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-xl outline-none"
              sideOffset={8}
            >
              <DropdownMenu.Item
                className="rounded-lg px-3 py-2 text-sm font-medium outline-none data-[highlighted]:bg-[var(--accent-muted)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
                onSelect={() => {
                  void authClient
                    .signOut()
                    .then(() => {
                      setSignOutError(false);
                      setAuthStatus({
                        state: 'unauthenticated',
                        reason: 'signed-out',
                      });
                    })
                    .catch(() => setSignOutError(true));
                }}
              >
                Sign out
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        {signOutError ? (
          <p className="sr-only" role="alert">
            Cerebra couldn’t sign you out. Try again.
          </p>
        ) : null}
      </header>
      <section
        aria-label="Projects"
        className="mx-auto w-full max-w-255 px-5 pt-6"
      >
        {projectLoading ? <p role="status">Loading projects…</p> : null}
        {projectLoadError ? (
          <div role="alert">
            <p>Cerebra couldn’t load your projects. Try again.</p>
            <button
              className="secondary-button mt-2"
              type="button"
              disabled={projectLoading}
              onClick={() => setProjectReload((value) => value + 1)}
            >
              Retry loading projects
            </button>
          </div>
        ) : null}
        {projects !== null && projects.length > 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="current-project" className="font-bold">
              Project
            </label>
            <select
              id="current-project"
              className="rounded-lg border border-[var(--control-border)] bg-[var(--surface)] p-2"
              value={projectId ?? ''}
              onChange={(event) => openProject(event.target.value)}
            >
              <option value="" disabled>
                Choose a project
              </option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.owner}/{project.name}
                </option>
              ))}
            </select>
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                setAddingProject(true);
                window.location.hash = '';
                setHash('');
              }}
            >
              Add project
            </button>
          </div>
        ) : null}
        {projectSaveError ? (
          <p role="alert" className="mt-2 text-[var(--danger)]">
            Cerebra couldn’t remember your project selection. You can still
            choose it from the project list next time.
          </p>
        ) : null}
      </section>
      {settings !== null ? (
        <main className="mx-auto w-full max-w-255 px-5 py-10 sm:py-14">
          <nav aria-label="Settings" className="mb-8 flex gap-2">
            {(
              [
                ['credentials', 'Credentials', '#/settings/credentials'],
                ['agents', 'Agent types', '#/settings/agents'],
                ['limits', 'Limits', '#/settings/limits'],
                ['notifications', 'Notifications', '#/settings/notifications'],
                ['backups', 'Backups', '#/settings/backups'],
              ] as const
            ).map(([page, label, href]) => {
              const current =
                page === 'agents'
                  ? settings.page === 'agents' || settings.page === 'agent'
                  : settings.page === page;
              return (
                <a
                  aria-current={current ? 'page' : undefined}
                  className={`rounded-lg px-3 py-2 text-sm font-bold outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)] ${
                    current
                      ? 'bg-[var(--accent-muted)] text-[var(--accent)]'
                      : 'text-[var(--muted)]'
                  }`}
                  href={href}
                  key={page}
                >
                  {label}
                </a>
              );
            })}
          </nav>
          {settings.page === 'credentials' ? (
            <CredentialsPage
              key={projectId ?? 'instance'}
              client={credentialClient}
              projectId={projectId}
              storage={storage}
            />
          ) : settings.page === 'agents' ? (
            <AgentTypesList />
          ) : settings.page === 'backups' ? (
            <BackupsPage client={backupsClient} />
          ) : settings.page === 'limits' ? (
            <LimitsPage
              client={automaticStartsClient}
              key={projectId ?? 'instance'}
              projectId={projectId}
            />
          ) : settings.page === 'notifications' ? (
            <NotificationSettingsPage client={notificationSettingsClient} />
          ) : projectId === null ? (
            <p className="card">
              Add a project first, then give its agents credentials.
            </p>
          ) : (
            <AgentCredentialsPage
              agentType={settings.agentType}
              client={credentialClient}
              key={`${projectId}:${settings.agentType}`}
              projectId={projectId}
            />
          )}
        </main>
      ) : conversation !== null ? (
        <main className="mx-auto w-full max-w-255 px-5 py-6 sm:py-8">
          <ConversationPage
            client={conversationClient}
            key={conversation}
            onBack={() => {
              setProjectView('fleet');
              window.location.hash = '';
            }}
            onOpenItem={(nextProject, id) => {
              openProject(nextProject);
              setBoardRequest({ id, tab: 'overview' });
            }}
            onTryAgain={async (agentId) => {
              const { runId } = await (fleetClient ?? browserFleetClient).start(
                agentId,
              );
              window.location.hash = `#/conversations/${runId}`;
            }}
            runId={conversation}
          />
        </main>
      ) : (
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
          <div className="mt-10">
            <NavigatorQueue
              client={queueClient}
              onCountChange={setQueueCount}
              onOpenBackups={() => {
                focusBackups.current = true;
                window.location.hash = '#/settings/backups';
              }}
              onOpenConversation={(runId) => {
                window.location.hash = `#/conversations/${runId}`;
              }}
              onViewWork={(nextProject, id, tab) => {
                openProject(nextProject);
                setBoardRequest({ id, tab });
              }}
              openRequest={queueRequest}
              storage={storage}
            />
          </div>
          {projects !== null && !addingProject && projectId !== null ? (
            <>
              <nav aria-label="Project" className="mt-7 flex gap-1">
                {(
                  [
                    ['board', 'Board'],
                    ['fleet', 'Fleet'],
                  ] as const
                ).map(([view, label]) => (
                  <button
                    aria-current={projectView === view ? 'page' : undefined}
                    className={`rounded-lg px-3.5 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-[var(--focus)] ${
                      projectView === view
                        ? 'bg-[var(--accent-muted)] font-bold text-[var(--accent)]'
                        : 'text-[var(--muted)]'
                    }`}
                    key={view}
                    onClick={() => {
                      setProjectView(view);
                      setReturnToFleet(false);
                      setBoardRequest(null);
                    }}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </nav>
              {projectView === 'fleet' ? (
                <div className="mt-5">
                  <FleetPage
                    client={fleetClient}
                    key={projectId}
                    onOpenChat={(runId) => {
                      window.location.hash = `#/conversations/${runId}`;
                    }}
                    onViewSetup={(person) => {
                      window.location.hash = `#/settings/agents/${person.role}`;
                    }}
                    onViewWork={(id) => {
                      setBoardRequest({ id, tab: 'overview' });
                      setReturnToFleet(true);
                      setProjectView('board');
                    }}
                    projectId={projectId}
                    storage={storage}
                  />
                </div>
              ) : (
                <ProjectBoard
                  automaticStartsClient={automaticStartsClient}
                  boardClient={boardClient}
                  costClient={costClient}
                  key={projectId}
                  onClose={
                    returnToFleet
                      ? () => {
                          setReturnToFleet(false);
                          setBoardRequest(null);
                          setProjectView('fleet');
                        }
                      : undefined
                  }
                  openRequest={boardRequest}
                  projectId={projectId}
                  storage={storage}
                />
              )}
            </>
          ) : projects !== null && (addingProject || projects.length === 0) ? (
            <div className="mt-7">
              {projects.length > 0 ? (
                <button
                  type="button"
                  className="secondary-button mb-4"
                  onClick={() => setAddingProject(false)}
                >
                  Back to projects
                </button>
              ) : null}
              <ProjectRegistration
                projectClient={projectClient}
                onProjectRegistered={(project) => {
                  setProjects((current) => [
                    ...(current ?? []).filter(
                      (existing) => existing.id !== project.id,
                    ),
                    project,
                  ]);
                  rememberProject(project.id);
                  setAddingProject(true);
                }}
                onProjectAdded={(project) => {
                  openProject(project.id);
                }}
              />
            </div>
          ) : projects !== null ? (
            <p className="mt-7">
              Choose a project to open its board and fleet.
            </p>
          ) : null}
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
                Your data is still safe. Read the update details, then try
                again.
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
                  <strong>
                    {instance?.address ?? 'http://localhost:4317'}
                  </strong>
                  .
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
              <strong>Running work will stop.</strong> Updating restarts
              Cerebra. Work that was still running returns to its queue and can
              be started again.
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
                  } else if (
                    !event.shiftKey &&
                    document.activeElement === last
                  ) {
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
      )}
    </div>
  );
}
