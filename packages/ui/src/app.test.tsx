import { App as CerebraApp, type ThemeMediaQuery } from './app';
import type { AttentionClient, AttentionEntry } from './attention';
import type { AuthClient } from './auth';
import type { CostClient } from './costs';
import type { ConnectNotificationsOptions } from './notifications';
import type { BoardClient, WorkItem } from './board';
import type { CredentialClient, CredentialOverview } from './credentials';
import type { FleetClient } from './fleet';
import type { QueueClient } from './queue';
import type { ConversationClient } from './runs';
import { AuthenticationRequiredError } from './instance';
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act, type ComponentProps } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const savedProjects = [
  {
    id: 'project-1',
    owner: 'acme',
    name: 'website',
    prefix: 'WEB',
    defaultBranch: 'main',
    remote: 'https://github.com/acme/website.git',
  },
  {
    id: 'project-9',
    owner: 'acme',
    name: 'app',
    prefix: 'APP',
    defaultBranch: 'main',
    remote: 'https://github.com/acme/app.git',
  },
];
const directoryClient = { list: async () => savedProjects };

const noAttention: AttentionClient = { list: async () => [] };
const noCosts: CostClient = {
  forItem: async () => ({ runs: [], totalUsd: 0 }),
  forProject: async () => ({
    notLinkedUsd: 0,
    runs: [],
    totalUsd: 0,
    workItemsUsd: 0,
  }),
};

function App(props: ComponentProps<typeof CerebraApp>) {
  return (
    <CerebraApp
      attentionClient={noAttention}
      costClient={noCosts}
      notificationsConnector={() => () => undefined}
      projectDirectoryClient={directoryClient}
      {...props}
    />
  );
}

class FakeMediaQuery implements ThemeMediaQuery {
  public readonly listeners = new Set<(event: MediaQueryListEvent) => void>();

  public constructor(public matches: boolean) {}

  public addEventListener(
    type: 'change',
    listener: (event: MediaQueryListEvent) => void,
  ): void {
    if (type === 'change') {
      this.listeners.add(listener);
    }
  }

  public removeEventListener(
    type: 'change',
    listener: (event: MediaQueryListEvent) => void,
  ): void {
    if (type === 'change') {
      this.listeners.delete(listener);
    }
  }

  public update(matches: boolean): void {
    this.matches = matches;
    for (const listener of this.listeners) {
      listener({ matches } as MediaQueryListEvent);
    }
  }
}

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

const emptyQueue: QueueClient = {
  answer: async () => undefined,
  answerPlan: async () => undefined,
  decide: async () => undefined,
  list: async () => ({ entries: [], notices: [], total: 0 }),
};

const authenticatedAuth: AuthClient = {
  setup: async () => undefined,
  signIn: async () => undefined,
  signOut: async () => undefined,
  status: async () => ({ state: 'authenticated' }),
};

describe('App', () => {
  test('loads saved projects without browser state and opens the chosen board', async () => {
    const user = userEvent.setup();
    const storage = new Map<string, string>();
    render(
      <App
        authClient={authenticatedAuth}
        queueClient={emptyQueue}
        mediaQuery={new FakeMediaQuery(false)}
        storage={{
          getItem: (key) => storage.get(key) ?? null,
          setItem: (key, value) => void storage.set(key, value),
        }}
      />,
    );
    const picker = await screen.findByRole('combobox', { name: 'Project' });
    expect(
      await within(picker).findByRole('option', { name: 'acme/website' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('heading', { name: 'Add a GitHub project' }),
    ).toBeNull();
    await user.selectOptions(picker, 'project-1');
    expect(
      await screen.findByRole('region', { name: 'Project board' }),
    ).toBeTruthy();
    expect(storage.get('cerebra.project')).toBe('project-1');
    await user.selectOptions(picker, 'project-9');
    expect(storage.get('cerebra.project')).toBe('project-9');
  });

  test('remembers registration immediately and reopens the saved project on a returning visit', async () => {
    const user = userEvent.setup();
    const storage = new Map<string, string>();
    const project = savedProjects[0];
    const props = {
      authClient: authenticatedAuth,
      queueClient: emptyQueue,
      mediaQuery: new FakeMediaQuery(false),
      storage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => void storage.set(key, value),
      },
    };
    const first = render(
      <App
        {...props}
        projectDirectoryClient={{ list: async () => [] }}
        projectClient={{
          discover: async () => project,
          register: async () => project,
        }}
      />,
    );
    await screen.findByRole('heading', { name: 'Add a GitHub project' });
    await user.type(
      screen.getByLabelText('GitHub repository link'),
      project.remote,
    );
    await user.type(
      screen.getByLabelText('GitHub access token'),
      'synthetic-token',
    );
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(
      await screen.findByRole('button', { name: 'Add project' }),
    );
    await screen.findByRole('heading', { name: 'Project added' });
    expect(storage.get('cerebra.project')).toBe(project.id);
    first.unmount();

    render(<App {...props} />);
    expect(
      await screen.findByRole('region', { name: 'Project board' }),
    ).toBeTruthy();
    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Project' })
        .value,
    ).toBe(project.id);
    expect(
      screen.queryByRole('heading', { name: 'Add a GitHub project' }),
    ).toBeNull();
  });

  test('recovers from a stale saved project and supports selection without writable browser storage', async () => {
    const user = userEvent.setup();
    render(
      <App
        authClient={authenticatedAuth}
        queueClient={emptyQueue}
        mediaQuery={new FakeMediaQuery(false)}
        storage={{
          getItem: (key) =>
            key === 'cerebra.project' ? 'deleted-project' : null,
          setItem: () => {
            throw new Error('Storage unavailable');
          },
        }}
      />,
    );
    const picker = await screen.findByRole<HTMLSelectElement>('combobox', {
      name: 'Project',
    });
    expect(picker.value).toBe('');
    expect(
      screen.queryByRole('heading', { name: 'Add a GitHub project' }),
    ).toBeNull();
    await user.selectOptions(picker, 'project-1');
    expect(
      await screen.findByRole('region', { name: 'Project board' }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Cerebra couldn’t remember your project selection/),
    ).toBeTruthy();
  });

  test('does not mistake a failed project read for first-use onboarding and can retry', async () => {
    const user = userEvent.setup();
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(savedProjects);
    render(
      <App
        authClient={authenticatedAuth}
        queueClient={emptyQueue}
        mediaQuery={new FakeMediaQuery(false)}
        projectDirectoryClient={{ list }}
        storage={{ getItem: () => null, setItem: () => undefined }}
      />,
    );
    expect(
      await screen.findByText(
        'Cerebra couldn’t load your projects. Try again.',
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole('heading', { name: 'Add a GitHub project' }),
    ).toBeNull();
    await user.click(
      screen.getByRole('button', { name: 'Retry loading projects' }),
    );
    expect(
      await screen.findByRole('option', { name: 'acme/website' }),
    ).toBeTruthy();
  });
  test('renders the agreed empty state and selects an appearance by keyboard', async () => {
    const user = userEvent.setup();
    const mediaQuery = new FakeMediaQuery(false);
    const storage = new Map<string, string>();

    render(
      <App
        mediaQuery={mediaQuery}
        authClient={authenticatedAuth}
        storage={{
          getItem: (key) => storage.get(key) ?? null,
          setItem: (key, value) => storage.set(key, value),
        }}
        instanceClient={{
          getStatus: async () => ({
            address: 'http://localhost:4317',
            lastUpdatedAt: '2026-09-28T20:00:00.000Z',
            status: 'running',
            version: '0.0.0',
          }),
          update: async () => undefined,
        }}
      />,
    );

    await screen.findByRole('heading', { name: 'Manage Cerebra' });
    expect(screen.getByText('Cerebra')).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'Manage Cerebra' }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Your private workspace is available only on this computer.',
      ),
    ).toBeTruthy();
    expect(
      await screen.findByRole('heading', { name: 'Instance status' }),
    ).toBeTruthy();
    expect(screen.getByText('Update Cerebra')).toBeTruthy();

    screen.getByRole('button', { name: 'Theme: System' });
    await user.keyboard('{Tab}{Tab}{Tab}{Tab}{ArrowDown}');

    expect(screen.getByRole('menu')).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('menuitemradio', { name: 'System' }),
      );
    });

    await user.keyboard('{ArrowUp}{Enter}');

    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Theme: Dark' }),
    );
    expect(storage.get('cerebra.theme')).toBe('dark');
  });

  test('sets up a valid first password and opens the authenticated application', async () => {
    const user = userEvent.setup();
    const setup = vi.fn(async () => undefined);

    render(
      <App
        authClient={{
          setup,
          signIn: async () => undefined,
          signOut: async () => undefined,
          status: async () => ({ state: 'setup' }),
        }}
        mediaQuery={new FakeMediaQuery(false)}
      />,
    );

    expect(
      await screen.findByRole('heading', { name: 'Protect Cerebra' }),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole('button', {
          name: 'Create password',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await user.type(screen.getByLabelText('Password'), 'a password');
    await user.type(screen.getByLabelText('Confirm password'), 'a password');
    await user.click(screen.getByRole('button', { name: 'Create password' }));

    expect(setup).toHaveBeenCalledWith('a password');
    expect(
      await screen.findByRole('heading', { name: 'Manage Cerebra' }),
    ).toBeTruthy();
  });

  test('follows a changed system preference while System is selected', async () => {
    const mediaQuery = new FakeMediaQuery(false);
    render(
      <App
        authClient={authenticatedAuth}
        mediaQuery={mediaQuery}
        storage={window.localStorage}
      />,
    );

    await screen.findByRole('combobox', { name: 'Project' });
    expect(document.documentElement.dataset.theme).toBe('light');
    act(() => mediaQuery.update(true));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  test('leaves the menu open and explains a failed appearance save', async () => {
    const user = userEvent.setup();
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('Storage is unavailable');
      },
    };

    render(
      <App
        authClient={authenticatedAuth}
        mediaQuery={new FakeMediaQuery(false)}
        storage={storage}
      />,
    );
    await user.click(
      await screen.findByRole('button', { name: 'Theme: System' }),
    );
    await user.click(screen.getByRole('menuitemradio', { name: 'Dark' }));

    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(
      'Cerebra couldn’t save that appearance choice. It will reset when you close this page.',
    );
  });

  test('applies an appearance for the current visit when browser storage is unavailable', async () => {
    const user = userEvent.setup();
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');

    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('Storage is unavailable', 'SecurityError');
      },
    });

    try {
      render(
        <App
          authClient={authenticatedAuth}
          mediaQuery={new FakeMediaQuery(false)}
        />,
      );
      await user.click(
        await screen.findByRole('button', { name: 'Theme: System' }),
      );
      await user.click(screen.getByRole('menuitemradio', { name: 'Dark' }));

      expect(document.documentElement.dataset.theme).toBe('dark');
      expect(screen.getByRole('alert').textContent).toBe(
        'Cerebra couldn’t save that appearance choice. It will reset when you close this page.',
      );
    } finally {
      Object.defineProperty(window, 'localStorage', descriptor!);
    }
  });

  test('returns to sign-in when a protected request finds an expired session', async () => {
    render(
      <App
        authClient={authenticatedAuth}
        instanceClient={{
          getStatus: async () => {
            throw new AuthenticationRequiredError('expired');
          },
          update: async () => undefined,
        }}
        mediaQuery={new FakeMediaQuery(false)}
      />,
    );

    expect(
      await screen.findByRole('heading', { name: 'Sign in to continue' }),
    ).toBeTruthy();
    expect(
      screen.getByText('For your security, please enter your password again.'),
    ).toBeTruthy();
  });

  test('keeps access open and explains a failed sign-out', async () => {
    const user = userEvent.setup();

    render(
      <App
        queueClient={emptyQueue}
        authClient={{
          ...authenticatedAuth,
          signOut: async () => {
            throw new Error('Network error');
          },
        }}
        mediaQuery={new FakeMediaQuery(false)}
      />,
    );

    await screen.findByRole('heading', { name: 'Manage Cerebra' });
    await user.click(screen.getByRole('button', { name: 'Account' }));
    await user.click(screen.getByRole('menuitem', { name: 'Sign out' }));

    expect(
      await screen.findByRole('heading', { name: 'Manage Cerebra' }),
    ).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe(
      'Cerebra couldn’t sign you out. Try again.',
    );
  });
  test('opens the navigator queue first, counts it and views work on its board', async () => {
    const user = userEvent.setup();
    const storage = new Map<string, string>([['cerebra.project', 'project-9']]);
    const item: WorkItem = {
      createdAt: '2026-09-29T00:00:00.000Z',
      description: '',
      id: 'item-1',
      priority: null,
      state: 'waiting',
      title: 'Which release should we support?',
      updatedAt: '2026-09-29T00:00:00.000Z',
    };
    const listed: string[] = [];
    const unused = async () => {
      throw new Error('Not exercised');
    };
    const boardClient: BoardClient = {
      addComment: unused,
      arrivals: async () => 0,
      cancel: unused,
      comments: async () => [],
      create: unused,
      history: async () => [],
      item: async () => item,
      list: async (projectId) => {
        listed.push(projectId);
        return { items: [item], nextCursor: null, snapshot: '1', total: 1 };
      },
      triage: unused,
    };
    const queueClient: QueueClient = {
      answer: unused,
      decide: unused,
      list: async () => ({
        entries: [
          {
            askedBy: 'Groomer',
            availableRoutes: ['build_ready'],
            description: '',
            id: 'item-1',
            kind: 'question',
            priority: 'P1',
            projectId: 'project-1',
            projectName: 'acme/mobile',
            run: null,
            since: '2026-09-29T00:00:00.000Z',
            title: 'Which release should we support?',
            waitingReason: 'Current app only?',
          },
          {
            askedBy: null,
            availableRoutes: ['build_ready'],
            description: '',
            id: 'item-2',
            kind: 'attention',
            priority: 'P2',
            projectId: 'project-1',
            projectName: 'acme/mobile',
            run: null,
            since: '2026-09-29T00:00:00.000Z',
            title: 'Check the payment flow',
            waitingReason: 'The build failed twice.',
          },
        ],
        notices: [],
        total: 2,
      }),
    };

    render(
      <App
        authClient={authenticatedAuth}
        boardClient={boardClient}
        instanceClient={{
          getStatus: async () => ({
            address: 'http://localhost:4317',
            lastUpdatedAt: '2026-09-28T20:00:00.000Z',
            status: 'running',
            version: '0.0.0',
          }),
          update: async () => undefined,
        }}
        mediaQuery={new FakeMediaQuery(false)}
        queueClient={queueClient}
        storage={{
          getItem: (key) => storage.get(key) ?? null,
          setItem: (key, value) => storage.set(key, value),
        }}
      />,
    );

    const queueLink = await screen.findByRole('link', {
      name: 'Navigator queue 2',
    });
    expect(document.title).toBe('(2) Cerebra');
    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings.indexOf('What needs you')).toBeLessThan(
      headings.indexOf('Project board'),
    );
    await user.click(queueLink);
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'What needs you' }),
    );

    await user.click(
      await within(
        screen.getByRole('region', { name: 'Navigator queue' }),
      ).findByRole('button', { name: /Which release should/ }),
    );
    await user.click(screen.getByRole('button', { name: 'Open conversation' }));

    expect(storage.get('cerebra.project')).toBe('project-1');
    await waitFor(() => expect(listed).toContain('project-1'));
    const board = screen.getByRole('region', { name: 'Project board' });
    expect(
      await within(board).findByRole('tab', {
        name: 'Discussion',
        selected: true,
      }),
    ).toBeTruthy();

    await user.click(
      screen.getByRole('button', { name: /Check the payment flow/ }),
    );
    const request = screen.getByRole('complementary', {
      name: 'Selected request',
    });
    await user.click(
      within(request).getByRole('radio', { name: /Cancel this work/ }),
    );
    await user.type(within(request).getByLabelText('Reason'), 'Not needed.');
    await user.click(
      within(request).getByRole('button', { name: 'Save decision' }),
    );
    expect(
      screen.getByRole('dialog', { name: 'Cancel this work?' }),
    ).toBeTruthy();
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(request).getByRole('button', { name: 'Save decision' }),
      ),
    );
    expect(
      within(board).getByRole('tab', { name: 'Discussion', selected: true }),
    ).toBeTruthy();
  });

  test('opens credential, agent and limit settings from the header, and returns to the queue', async () => {
    const user = userEvent.setup();
    const projects: Array<string | null> = [];
    const credentialClient: CredentialClient = {
      agentCredentials: async (_projectId, agentType) => ({
        agentType,
        available: [],
        entries: [],
      }),
      overview: async (projectId) => {
        projects.push(projectId);
        return {
          attention: [],
          instanceCredentials: [],
          project: { id: 'project-9', name: 'acme/app' },
          projectCredentials: [],
        };
      },
      remove: async () => undefined,
      save: async ({ name }) => ({ name, replaced: false }),
      setAgentCredentials: async (_projectId, agentType) => ({
        agentType,
        available: [],
        entries: [],
      }),
    };
    const storage = new Map<string, string>([['cerebra.project', 'project-9']]);

    render(
      <App
        authClient={authenticatedAuth}
        automaticStartsClient={{
          limits: async () => ({ instanceLimit: 3, projectLimit: 2 }),
          saveInstanceLimit: async () => ({
            instanceLimit: 3,
            projectLimit: null,
          }),
          saveProjectLimit: async () => ({ instanceLimit: 3, projectLimit: 2 }),
          setPaused: async () => undefined,
          status: async () => ({
            limit: 2,
            paused: false,
            running: 0,
            waiting: [],
          }),
        }}
        credentialClient={credentialClient}
        mediaQuery={new FakeMediaQuery(false)}
        queueClient={emptyQueue}
        storage={{
          getItem: (key) => storage.get(key) ?? null,
          setItem: (key, value) => void storage.set(key, value),
        }}
      />,
    );

    await user.click(await screen.findByRole('link', { name: 'Settings' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Credentials' }),
    ).toBeTruthy();
    expect(window.location.hash).toBe('#/settings/credentials');
    expect(
      await screen.findByText('No credentials saved for this project'),
    ).toBeTruthy();
    expect(projects).toEqual(['project-9']);

    await user.click(screen.getByRole('link', { name: 'Limits' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Limits' }),
    ).toBeTruthy();
    expect(window.location.hash).toBe('#/settings/limits');
    expect(await screen.findByText('Cerebra-wide limit is 3.')).toBeTruthy();

    await user.click(screen.getByRole('link', { name: 'Agent types' }));
    await user.click(
      await screen.findByRole('link', { name: 'Edit Producer' }),
    );

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Edit Producer' }),
    ).toBeTruthy();

    await user.click(screen.getByRole('link', { name: /Navigator queue/ }));

    expect(
      await screen.findByRole('heading', { name: 'Manage Cerebra' }),
    ).toBeTruthy();
  });

  test('a failed backup in the queue opens Settings → Backups on its heading', async () => {
    const user = userEvent.setup();
    const storage = new Map<string, string>();
    render(
      <App
        authClient={authenticatedAuth}
        backupsClient={{
          start: async () => {
            throw new Error('Not exercised');
          },
          status: async () => ({
            backups: [],
            kept: 0,
            running: null,
            schedule: {
              keep: 7,
              location: '/backups',
              nextAt: '2026-10-02T00:00:00.000Z',
            },
          }),
        }}
        mediaQuery={new FakeMediaQuery(false)}
        queueClient={{
          ...emptyQueue,
          list: async () => ({
            entries: [],
            notices: [
              {
                at: '2026-10-01T00:00:00.000Z',
                cause: 'the backup folder is full',
                kind: 'backup_failed',
              },
            ],
            total: 0,
          }),
        }}
        storage={{
          getItem: (key) => storage.get(key) ?? null,
          setItem: (key, value) => void storage.set(key, value),
        }}
      />,
    );

    await user.click(
      await screen.findByRole('button', { name: 'Open Backups' }),
    );

    const heading = await screen.findByRole('heading', {
      level: 1,
      name: 'Backups',
    });
    expect(window.location.hash).toBe('#/settings/backups');
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(
      screen
        .getByRole('link', { name: 'Backups' })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(document.title).toBe('(1) Cerebra');
  });

  test('switches a project between its board and its fleet, and View work returns to the fleet', async () => {
    const user = userEvent.setup();
    const storage = new Map<string, string>([['cerebra.project', 'project-1']]);
    const item: WorkItem = {
      createdAt: '2026-09-29T00:00:00.000Z',
      description: '',
      id: 'item-2',
      priority: 'P1',
      state: 'building',
      title: 'Make sign-in clearer',
      updatedAt: '2026-09-29T00:00:00.000Z',
    };
    const unused = async () => {
      throw new Error('Not exercised');
    };
    const boardClient: BoardClient = {
      addComment: unused,
      arrivals: async () => 0,
      cancel: unused,
      comments: async () => [],
      create: unused,
      history: async () => [],
      item: async () => item,
      list: async () => ({
        items: [item],
        nextCursor: null,
        snapshot: '1',
        total: 1,
      }),
      triage: unused,
    };
    const fleetClient: FleetClient = {
      addPerson: unused,
      read: async () => ({
        people: [
          {
            activity: {
              item: { id: 'item-2', title: 'Make sign-in clearer' },
              kind: 'working',
            },
            conversation: null,
            enabled: true,
            id: 'agent-1',
            name: 'Magma',
            role: 'producer',
            running: true,
            startFailed: false,
            typeId: 'type-producer',
          },
        ],
        project: { id: 'project-1', name: 'admin', owner: 'northstar' },
        roles: [
          {
            interactive: false,
            model: 'opus',
            people: ['Magma'],
            role: 'producer',
            startMode: 'ready',
            typeId: 'type-producer',
          },
        ],
      }),
      removePerson: unused,
      saveRoleSettings: unused,
      start: unused,
      stop: unused,
      updatePerson: unused,
    };

    render(
      <App
        authClient={authenticatedAuth}
        boardClient={boardClient}
        fleetClient={fleetClient}
        instanceClient={{
          getStatus: async () => ({
            address: 'http://localhost:4317',
            lastUpdatedAt: '2026-09-28T20:00:00.000Z',
            status: 'running',
            version: '0.0.0',
          }),
          update: async () => undefined,
        }}
        mediaQuery={new FakeMediaQuery(false)}
        queueClient={emptyQueue}
        storage={{
          getItem: (key) => storage.get(key) ?? null,
          setItem: (key, value) => storage.set(key, value),
        }}
      />,
    );

    const project = await screen.findByRole('navigation', { name: 'Project' });
    expect(
      within(project)
        .getByRole('button', { name: 'Board' })
        .getAttribute('aria-current'),
    ).toBe('page');
    await user.click(within(project).getByRole('button', { name: 'Fleet' }));
    expect(
      await screen.findByRole('heading', { name: 'Your fleet' }),
    ).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Project board' })).toBeNull();

    await user.click(
      within(await screen.findByRole('article', { name: 'Magma' })).getByRole(
        'button',
        { name: 'View work' },
      ),
    );
    const board = await screen.findByRole('region', { name: 'Project board' });
    expect(
      await within(board).findByRole('heading', {
        name: 'Make sign-in clearer',
      }),
    ).toBeTruthy();

    await user.click(
      within(board).getAllByRole('button', {
        name: /^(Close|Back to board)$/,
      })[0],
    );

    expect(
      await screen.findByRole('heading', { name: 'Your fleet' }),
    ).toBeTruthy();
  });

  test.each(['back', 'switch'])(
    'a conversation link opens and %s leaves it',
    async (action) => {
      const user = userEvent.setup();
      const runId = '5b3c4a8e-8f0e-4c7a-9d57-1f2a3b4c5d6e';
      const read: string[] = [];
      const conversationClient: ConversationClient = {
        answer: async () => undefined,
        answerPlan: async () => undefined,
        read: async (id) => {
          read.push(id);
          return {
            events: [],
            run: {
              agentId: 'agent-astra',
              agentName: 'Astra',
              agentRole: 'assistant',
              endedAt: null,
              failure: null,
              id,
              item: null,
              projectId: 'project-1',
              startedAt: '2026-10-01T09:30:00.000Z',
              state: 'starting',
            },
          };
        },
        send: async () => undefined,
        stop: async () => undefined,
        subscribe: () => () => undefined,
      };
      window.location.hash = `#/conversations/${runId}`;

      render(
        <App
          authClient={authenticatedAuth}
          conversationClient={conversationClient}
          mediaQuery={new FakeMediaQuery(false)}
          queueClient={emptyQueue}
          storage={{ getItem: () => null, setItem: () => undefined }}
        />,
      );

      expect(
        await screen.findByRole('heading', { level: 1, name: 'Astra' }),
      ).toBeTruthy();
      expect(read).toEqual([runId]);
      expect(
        screen.queryByRole('heading', { name: 'Manage Cerebra' }),
      ).toBeNull();

      if (action === 'back') {
        await user.click(screen.getByRole('button', { name: 'Back to fleet' }));
      } else {
        await user.selectOptions(
          await screen.findByRole('combobox', { name: 'Project' }),
          'project-9',
        );
        expect(
          await screen.findByRole('region', { name: 'Project board' }),
        ).toBeTruthy();
        expect(
          screen.queryByRole('heading', { level: 1, name: 'Astra' }),
        ).toBeNull();
      }
      expect(window.location.hash).toBe('');
      expect(
        await screen.findByRole('heading', { name: 'Manage Cerebra' }),
      ).toBeTruthy();
    },
  );

  test('Answer on an assistant’s question opens its conversation with the question form focused', async () => {
    const user = userEvent.setup();
    const runId = '7c3c4a8e-8f0e-4c7a-9d57-1f2a3b4c5d6e';
    const conversationClient: ConversationClient = {
      answer: async () => undefined,
      answerPlan: async () => undefined,
      read: async (id) => ({
        events: [
          {
            createdAt: '2026-10-01T09:31:00.000Z',
            event: {
              kind: 'question',
              questionId: 'q-1',
              questions: [
                {
                  header: '',
                  multiSelect: false,
                  options: [{ description: '', label: 'Postgres' }],
                  question: 'Which database should the demo use?',
                },
              ],
            },
            position: 1,
          },
        ],
        run: {
          agentId: 'agent-astra',
          agentName: 'Astra',
          agentRole: 'assistant',
          endedAt: null,
          failure: null,
          id,
          item: null,
          projectId: 'project-1',
          startedAt: '2026-10-01T09:30:00.000Z',
          state: 'awaiting_input',
        },
      }),
      send: async () => undefined,
      stop: async () => undefined,
      subscribe: () => () => undefined,
    };
    const queueClient: QueueClient = {
      ...emptyQueue,
      list: async () => ({
        entries: [
          {
            askedBy: 'Astra',
            availableRoutes: [],
            description: '',
            id: `run:${runId}:q-1`,
            kind: 'question',
            priority: null,
            projectId: 'project-1',
            projectName: 'acme/mobile',
            run: { id: runId },
            since: '2026-10-01T09:31:00.000Z',
            title: 'Which database should the demo use?',
            waitingReason: 'Which database should the demo use?',
          },
        ],
        notices: [],
        total: 1,
      }),
    };

    render(
      <App
        authClient={authenticatedAuth}
        conversationClient={conversationClient}
        mediaQuery={new FakeMediaQuery(false)}
        queueClient={queueClient}
        storage={{ getItem: () => null, setItem: () => undefined }}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Answer' }));

    expect(window.location.hash).toBe(`#/conversations/${runId}`);
    const form = await screen.findByRole('form', {
      name: 'Which database should the demo use?',
    });
    await waitFor(() => expect(document.activeElement).toBe(form));
    window.location.hash = '';
  });

  test('an item filed in a conversation opens on its project board', async () => {
    const user = userEvent.setup();
    const runId = '8d4d5b9f-9f1f-4d8b-8e68-2a3b4c5d6e7f';
    const filed: WorkItem = {
      createdAt: '2026-10-01T09:32:00.000Z',
      description: '',
      id: 'item-7',
      priority: null,
      state: 'new',
      title: 'Bulk export for credit notes',
      updatedAt: '2026-10-01T09:32:00.000Z',
    };
    const unused = async () => {
      throw new Error('Not exercised');
    };
    const boardClient: BoardClient = {
      addComment: unused,
      arrivals: async () => 0,
      cancel: unused,
      comments: async () => [],
      create: unused,
      history: async () => [],
      item: async () => filed,
      list: async () => ({
        items: [filed],
        nextCursor: null,
        snapshot: '1',
        total: 1,
      }),
      triage: unused,
    };
    const conversationClient: ConversationClient = {
      answer: async () => undefined,
      answerPlan: async () => undefined,
      read: async (id) => ({
        events: [
          {
            createdAt: '2026-10-01T09:32:00.000Z',
            event: {
              input: { description: '', title: filed.title },
              kind: 'tool_call',
              name: 'mcp__cerebra__create_item',
              toolCallId: 'c1',
            },
            position: 1,
          },
          {
            createdAt: '2026-10-01T09:32:00.000Z',
            event: {
              content: '{"id":"item-7","priority":null,"state":"new"}',
              isError: false,
              kind: 'tool_result',
              toolCallId: 'c1',
            },
            position: 2,
          },
        ],
        run: {
          agentId: 'agent-gale',
          agentName: 'Gale',
          agentRole: 'groomer',
          endedAt: null,
          failure: null,
          id,
          item: { id: 'item-1', title: 'Export invoices as CSV' },
          projectId: 'project-1',
          startedAt: '2026-10-01T09:30:00.000Z',
          state: 'active',
        },
      }),
      send: async () => undefined,
      stop: async () => undefined,
      subscribe: () => () => undefined,
    };
    window.location.hash = `#/conversations/${runId}`;

    render(
      <App
        authClient={authenticatedAuth}
        boardClient={boardClient}
        conversationClient={conversationClient}
        mediaQuery={new FakeMediaQuery(false)}
        queueClient={emptyQueue}
        storage={{ getItem: () => null, setItem: () => undefined }}
      />,
    );

    await user.click(await screen.findByRole('button', { name: filed.title }));

    const board = await screen.findByRole('region', { name: 'Project board' });
    expect(
      await within(board).findByRole('heading', { name: filed.title }),
    ).toBeTruthy();
    expect(window.location.hash).toBe('');
  });

  test('switching projects discards a previous project’s delayed credential response', async () => {
    const user = userEvent.setup();
    let finishFirst: (value: CredentialOverview) => void = () => {
      throw new Error('First request not started');
    };
    const first = new Promise<CredentialOverview>((resolve) => {
      finishFirst = resolve;
    });
    const overview = (id: string): CredentialOverview => ({
      attention: [],
      instanceCredentials: [],
      project: { id, name: id },
      projectCredentials: [
        {
          id: `credential-${id}`,
          name: `Token for ${id}`,
          scope: 'project',
          lastUsedAt: null,
          lastUsedRunId: null,
          needsAttention: false,
          usedBy: [],
          usedByEveryAgent: false,
        },
      ],
    });
    const unused = async () => {
      throw new Error('Not exercised');
    };
    const client: CredentialClient = {
      overview: (id) =>
        id === 'project-1' ? first : Promise.resolve(overview('project-9')),
      agentCredentials: unused,
      remove: unused,
      save: unused,
      setAgentCredentials: unused,
    };
    window.location.hash = '#/settings/credentials';
    render(
      <App
        authClient={authenticatedAuth}
        credentialClient={client}
        mediaQuery={new FakeMediaQuery(false)}
        storage={{
          getItem: (key) => (key === 'cerebra.project' ? 'project-1' : null),
          setItem: () => undefined,
        }}
      />,
    );
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Project' }),
      'project-9',
    );
    expect(await screen.findByText('Token for project-9')).toBeTruthy();
    await act(async () => finishFirst(overview('project-1')));
    expect(screen.queryByText('Token for project-1')).toBeNull();
    expect(screen.getByText('Token for project-9')).toBeTruthy();
  });

  test('the attention center opens a question in its conversation and waiting work in the queue', async () => {
    const user = userEvent.setup();
    const entries: AttentionEntry[] = [
      {
        agentName: 'Storm',
        id: 'run:run-1',
        itemId: null,
        kind: 'question',
        projectId: 'project-1',
        projectName: 'acme/website',
        runId: '11111111-1111-4111-8111-111111111111',
        since: new Date().toISOString(),
        title: 'Choose a layout for the project board',
      },
      {
        agentName: null,
        id: 'item-7',
        itemId: 'item-7',
        kind: 'waiting',
        projectId: 'project-1',
        projectName: 'acme/website',
        runId: null,
        since: new Date().toISOString(),
        title: 'Review the delivery plan',
      },
    ];
    const queueClient: QueueClient = {
      ...emptyQueue,
      list: async () => ({
        entries: [
          {
            askedBy: null,
            availableRoutes: [],
            description: '',
            id: 'item-7',
            kind: 'review',
            priority: 'P2',
            projectId: 'project-1',
            projectName: 'acme/website',
            run: null,
            since: new Date().toISOString(),
            title: 'Review the delivery plan',
            waitingReason: null,
          },
        ],
        notices: [],
        total: 1,
      }),
    };
    render(
      <App
        attentionClient={{ list: async () => entries }}
        authClient={authenticatedAuth}
        mediaQuery={new FakeMediaQuery(false)}
        queueClient={queueClient}
      />,
    );
    const control = await screen.findByRole('button', {
      name: 'Open attention center',
    });
    expect(await within(control).findByText('2')).toBeTruthy();

    await user.click(control);
    await user.click(
      screen.getByRole('button', {
        name: /Choose a layout for the project board/,
      }),
    );
    expect(window.location.hash).toBe(
      '#/conversations/11111111-1111-4111-8111-111111111111',
    );

    await user.click(control);
    await user.click(
      screen.getByRole('button', { name: /WAITING.*Review the delivery plan/ }),
    );
    expect(window.location.hash).toBe('');
    const row = await screen.findByRole('button', {
      name: /Review the delivery plan/,
    });
    await waitFor(() => expect(row.getAttribute('aria-current')).toBe('true'));
  });

  test('Notification settings opens its own settings tab', async () => {
    const user = userEvent.setup();
    render(
      <App
        authClient={authenticatedAuth}
        mediaQuery={new FakeMediaQuery(false)}
        notificationSettingsClient={{
          list: async () => [
            {
              browserNotifications: true,
              projectId: 'project-1',
              projectName: 'acme/website',
            },
          ],
          set: async () => undefined,
        }}
        queueClient={emptyQueue}
      />,
    );
    await user.click(
      await screen.findByRole('button', { name: 'Open attention center' }),
    );
    await user.click(
      screen.getByRole('button', { name: 'Notification settings' }),
    );

    expect(window.location.hash).toBe('#/settings/notifications');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Notifications' }),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('navigation', { name: 'Settings' }))
        .getByRole('link', { name: 'Notifications' })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(
      await screen.findByRole('switch', { name: 'Browser notifications' }),
    ).toBeTruthy();
  });

  test('a push reads the attention list again, and a batch alert opens the panel', async () => {
    let options: Pick<
      ConnectNotificationsOptions,
      'onOpenEntry' | 'onOpenPanel' | 'onPush'
    > | null = null;
    const disconnect = vi.fn();
    const list = vi.fn(async () => [] as AttentionEntry[]);
    const view = render(
      <App
        attentionClient={{ list }}
        authClient={authenticatedAuth}
        mediaQuery={new FakeMediaQuery(false)}
        notificationsConnector={(given) => {
          options = given;
          return disconnect;
        }}
        queueClient={emptyQueue}
      />,
    );
    await waitFor(() => expect(options).not.toBeNull());
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    await act(async () => options!.onPush([]));
    expect(list).toHaveBeenCalledTimes(2);

    await act(async () => options!.onOpenPanel());
    expect(
      screen.getByRole('region', { name: 'Needs your attention' }),
    ).toBeTruthy();

    view.unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});
