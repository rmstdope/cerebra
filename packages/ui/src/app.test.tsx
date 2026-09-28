import { App, type ThemeMediaQuery } from './app';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, describe, expect, test } from 'vitest';

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

describe('App', () => {
  test('renders the agreed empty state and selects an appearance by keyboard', async () => {
    const user = userEvent.setup();
    const mediaQuery = new FakeMediaQuery(false);
    const storage = new Map<string, string>();

    render(
      <App
        mediaQuery={mediaQuery}
        storage={{
          getItem: (key) => storage.get(key) ?? null,
          setItem: (key, value) => storage.set(key, value),
        }}
      />,
    );

    expect(screen.getByText('Cerebra')).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'Welcome to Cerebra' }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'There is nothing to review yet. Add your first project to start organising work here.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('No projects have been added')).toBeTruthy();
    expect(
      screen.getByText(
        'Your projects and any work waiting for you will appear in this space.',
      ),
    ).toBeTruthy();

    screen.getByRole('button', { name: 'Theme: System' });
    await user.keyboard('{Tab}{ArrowDown}');

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

  test('follows a changed system preference while System is selected', () => {
    const mediaQuery = new FakeMediaQuery(false);
    render(<App mediaQuery={mediaQuery} storage={window.localStorage} />);

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

    render(<App mediaQuery={new FakeMediaQuery(false)} storage={storage} />);
    await user.click(screen.getByRole('button', { name: 'Theme: System' }));
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
      render(<App mediaQuery={new FakeMediaQuery(false)} />);
      await user.click(screen.getByRole('button', { name: 'Theme: System' }));
      await user.click(screen.getByRole('menuitemradio', { name: 'Dark' }));

      expect(document.documentElement.dataset.theme).toBe('dark');
      expect(screen.getByRole('alert').textContent).toBe(
        'Cerebra couldn’t save that appearance choice. It will reset when you close this page.',
      );
    } finally {
      Object.defineProperty(window, 'localStorage', descriptor!);
    }
  });
});
