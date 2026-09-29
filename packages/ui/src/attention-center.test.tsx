import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { AttentionClient, AttentionEntry } from './attention';
import { AttentionCenter } from './attention-center';

afterEach(() => {
  cleanup();
});

const now = new Date('2026-10-04T14:30:00');

const question: AttentionEntry = {
  agentName: 'Design chat',
  id: 'run:r1',
  itemId: null,
  kind: 'question',
  projectId: 'p1',
  projectName: 'Atlas',
  runId: 'r1',
  since: new Date('2026-10-04T14:29:40').toISOString(),
  title: 'Choose a layout for the project board',
};

const waiting: AttentionEntry = {
  agentName: null,
  id: 'item:i1',
  itemId: 'i1',
  kind: 'waiting',
  projectId: 'p2',
  projectName: 'Compass',
  runId: null,
  since: new Date('2026-10-04T14:26:00').toISOString(),
  title: 'Review the delivery plan',
};

const trouble: AttentionEntry = {
  agentName: 'Storm',
  id: 'trouble:r2',
  itemId: null,
  kind: 'trouble',
  projectId: 'p1',
  projectName: 'Atlas',
  runId: 'r2',
  since: new Date('2026-10-04T14:00:00').toISOString(),
  title: 'A run stopped before it could finish',
};

function fixed(
  entries: readonly AttentionEntry[] = [question, waiting, trouble],
): AttentionClient {
  return { list: async () => entries };
}

function renderCenter(
  props: Partial<Parameters<typeof AttentionCenter>[0]> = {},
) {
  const onOpen = vi.fn();
  const onOpenSettings = vi.fn();
  const view = render(
    <div>
      <button type="button">Elsewhere</button>
      <AttentionCenter
        client={fixed()}
        closeKey="board"
        now={() => now}
        onOpen={onOpen}
        onOpenSettings={onOpenSettings}
        pushSignal={0}
        {...props}
      />
    </div>,
  );
  return { onOpen, onOpenSettings, ...view };
}

function description(element: HTMLElement): string {
  return (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const control = () =>
  screen.getByRole('button', { name: 'Open attention center' });

test('the header control counts what needs attention and caps it at 99+', async () => {
  renderCenter();
  expect(await within(control()).findByText('3')).toBeTruthy();
  expect(description(control())).toBe('3 items need your attention');
  cleanup();

  const many = Array.from({ length: 120 }, (_, index) => ({
    ...waiting,
    id: `item:${index}`,
  }));
  renderCenter({ client: fixed(many) });
  expect(await within(control()).findByText('99+')).toBeTruthy();
});

test('no count shows when nothing needs attention', async () => {
  const list = vi.fn(async () => []);
  renderCenter({ client: { list } });
  await vi.waitFor(() => expect(list).toHaveBeenCalled());
  expect(control().textContent).toBe('');
  expect(description(control())).toBe('');
});

test('Enter opens the panel with focus on the first entry, and Escape returns focus', async () => {
  const user = userEvent.setup();
  renderCenter();
  await within(control()).findByText('3');

  control().focus();
  await user.keyboard('{Enter}');

  const panel = screen.getByRole('region', { name: 'Needs your attention' });
  expect(control().getAttribute('aria-expanded')).toBe('true');
  const entries = within(panel).getAllByRole('button', {
    name: /QUESTION|WAITING|TROUBLE/,
  });
  expect(entries).toHaveLength(3);
  expect(document.activeElement).toBe(entries[0]);
  expect(entries[0].textContent).toContain('QUESTION');
  expect(entries[0].textContent).toContain(
    'Choose a layout for the project board',
  );
  expect(entries[0].textContent).toContain('Atlas · Design chat · Now');
  expect(entries[1].textContent).toContain('WAITING');
  expect(entries[1].textContent).toContain('Compass · Waiting since 14:26');
  expect(entries[2].textContent).toContain('TROUBLE');
  expect(entries[2].textContent).toContain(
    'Atlas · Open the conversation to see what happened',
  );

  await user.keyboard('{Escape}');
  expect(
    screen.queryByRole('region', { name: 'Needs your attention' }),
  ).toBeNull();
  expect(control().getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(control());
});

test('Space opens the panel, and pressing the control again closes it', async () => {
  const user = userEvent.setup();
  renderCenter();
  await within(control()).findByText('3');

  control().focus();
  await user.keyboard(' ');
  expect(
    screen.getByRole('region', { name: 'Needs your attention' }),
  ).toBeTruthy();

  await user.click(control());
  expect(
    screen.queryByRole('region', { name: 'Needs your attention' }),
  ).toBeNull();
  expect(document.activeElement).toBe(control());
});

test('clicking outside the panel closes it', async () => {
  const user = userEvent.setup();
  renderCenter();
  await user.click(control());
  expect(
    screen.getByRole('region', { name: 'Needs your attention' }),
  ).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
  expect(
    screen.queryByRole('region', { name: 'Needs your attention' }),
  ).toBeNull();
});

test('selecting an entry opens it and closes the panel', async () => {
  const user = userEvent.setup();
  const { onOpen } = renderCenter();
  await within(control()).findByText('3');
  await user.click(control());

  await user.click(
    screen.getByRole('button', { name: /Review the delivery plan/ }),
  );
  expect(onOpen).toHaveBeenCalledWith(waiting);
  expect(
    screen.queryByRole('region', { name: 'Needs your attention' }),
  ).toBeNull();
});

test('Notification settings opens the settings and closes the panel', async () => {
  const user = userEvent.setup();
  const { onOpenSettings } = renderCenter();
  await user.click(control());

  await user.click(
    screen.getByRole('button', { name: 'Notification settings' }),
  );
  expect(onOpenSettings).toHaveBeenCalled();
  expect(
    screen.queryByRole('region', { name: 'Needs your attention' }),
  ).toBeNull();
});

test('with nothing to do the panel says so, with focus on Notification settings', async () => {
  const user = userEvent.setup();
  renderCenter({ client: fixed([]) });
  await user.click(control());

  expect(
    await screen.findByText(
      "You're all caught up. We'll let you know when something needs you.",
    ),
  ).toBeTruthy();
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Notification settings' }),
  );
});

test('a failed load says so and can be tried again', async () => {
  const user = userEvent.setup();
  let fail = true;
  const client: AttentionClient = {
    list: async () => {
      if (fail) throw new Error('down');
      return [question];
    },
  };
  renderCenter({ client });
  await user.click(control());

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain(
    "We couldn't load what needs your attention. Try again.",
  );
  fail = false;
  await user.click(within(alert).getByRole('button', { name: 'Try again' }));
  expect(
    await screen.findByRole('button', { name: /Choose a layout/ }),
  ).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a new entry while open waits behind "1 new item", and a resolved one leaves', async () => {
  const user = userEvent.setup();
  let entries: readonly AttentionEntry[] = [question, waiting];
  let resolve: (() => void) | null = null;
  const client: AttentionClient = {
    list: () =>
      new Promise((done) => {
        resolve = () => done(entries);
      }),
  };
  const view = renderCenter({ client });
  await act(async () => resolve?.());
  await user.click(control());
  const panel = screen.getByRole('region', { name: 'Needs your attention' });

  entries = [trouble, waiting];
  view.rerender(
    <div>
      <button type="button">Elsewhere</button>
      <AttentionCenter
        client={client}
        closeKey="board"
        now={() => now}
        onOpen={view.onOpen}
        onOpenSettings={view.onOpenSettings}
        pushSignal={1}
      />
    </div>,
  );
  expect(within(panel).getByText('Updating…')).toBeTruthy();
  await act(async () => resolve?.());

  expect(within(control()).getByText('2')).toBeTruthy();
  expect(
    within(panel).queryByText('Choose a layout for the project board'),
  ).toBeNull();
  expect(
    within(panel).queryByText('A run stopped before it could finish'),
  ).toBeNull();
  expect(within(panel).queryByText('Updating…')).toBeNull();

  await user.click(within(panel).getByRole('button', { name: '1 new item' }));
  expect(
    within(panel).getByText('A run stopped before it could finish'),
  ).toBeTruthy();
  expect(
    within(panel).queryByRole('button', { name: '1 new item' }),
  ).toBeNull();
});

test('switching projects closes the panel', async () => {
  const user = userEvent.setup();
  const view = renderCenter();
  await user.click(control());

  view.rerender(
    <div>
      <button type="button">Elsewhere</button>
      <AttentionCenter
        client={fixed()}
        closeKey="another project"
        now={() => now}
        onOpen={view.onOpen}
        onOpenSettings={view.onOpenSettings}
        pushSignal={0}
      />
    </div>,
  );
  expect(
    screen.queryByRole('region', { name: 'Needs your attention' }),
  ).toBeNull();
});

test('an open request from a browser alert opens the panel', async () => {
  const view = renderCenter({ openSignal: 0 });
  view.rerender(
    <div>
      <button type="button">Elsewhere</button>
      <AttentionCenter
        client={fixed()}
        closeKey="board"
        now={() => now}
        onOpen={view.onOpen}
        onOpenSettings={view.onOpenSettings}
        openSignal={1}
        pushSignal={0}
      />
    </div>,
  );
  expect(
    await screen.findByRole('region', { name: 'Needs your attention' }),
  ).toBeTruthy();
});

test('the list is read again on an interval', async () => {
  vi.useFakeTimers();
  try {
    const list = vi.fn(async () => [question]);
    renderCenter({ client: { list }, pollIntervalMs: 15_000 });
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(list).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
