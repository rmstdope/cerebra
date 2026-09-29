import { App, type ThemeMediaQuery } from './app';
import type { AuthClient } from './auth';
import type { BoardClient, WorkItem } from './board';
import type { QueueClient } from './queue';
import { AuthenticationRequiredError } from './instance';
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

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

afterEach(cleanup);

const emptyQueue: QueueClient = {
  answer: async () => undefined,
  decide: async () => undefined,
  list: async () => ({ entries: [], total: 0 }),
};

const authenticatedAuth: AuthClient = {
  setup: async () => undefined,
  signIn: async () => undefined,
  signOut: async () => undefined,
  status: async () => ({ state: 'authenticated' }),
};

describe('App', () => {
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
    await user.keyboard('{Tab}{Tab}{ArrowDown}');

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

  test('follows a changed system preference while System is selected', () => {
    const mediaQuery = new FakeMediaQuery(false);
    render(
      <App
        authClient={authenticatedAuth}
        mediaQuery={mediaQuery}
        storage={window.localStorage}
      />,
    );

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
            since: '2026-09-29T00:00:00.000Z',
            title: 'Which release should we support?',
            waitingReason: 'Current app only?',
          },
        ],
        total: 1,
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
      name: 'Navigator queue 1',
    });
    expect(document.title).toBe('(1) Cerebra');
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
      await screen.findByRole('button', { name: /Which release should/ }),
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
  });
});
