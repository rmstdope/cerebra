import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';

import {
  BoardRequestError,
  type BoardClient,
  type BoardFilters,
  type BoardPage,
  type WorkItem,
} from './board';
import { ProjectBoard } from './project-board';

afterEach(cleanup);

const workItem: WorkItem = {
  createdAt: '2026-09-29T00:00:00.000Z',
  description: 'Make the board easy to use.',
  id: 'item-1',
  priority: null,
  state: 'new',
  title: 'Show the board',
  updatedAt: '2026-09-29T00:00:00.000Z',
};

function page(
  items: readonly WorkItem[],
  extra: Partial<BoardPage> = {},
): BoardPage {
  return {
    items,
    nextCursor: null,
    snapshot: '1',
    total: items.length,
    ...extra,
  };
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

function createClient(overrides: Partial<BoardClient> = {}): BoardClient {
  return {
    addComment: async (_itemId, body) => ({
      body,
      createdAt: '2026-09-29T00:00:00.000Z',
      id: 1,
    }),
    arrivals: async () => 0,
    cancel: async () => ({ ...workItem, state: 'cancelled' }),
    comments: async () => [],
    create: async (_projectId, input) => ({
      ...workItem,
      description: input.description,
      id: 'item-2',
      title: input.title,
    }),
    history: async () => [],
    item: async () => workItem,
    list: async () => page([workItem]),
    triage: async (_itemId, priority, route) => ({
      ...workItem,
      priority,
      state: route,
    }),
    ...overrides,
  };
}

function renderBoard(
  client: BoardClient,
  storage = memoryStorage(),
  arrivalsIntervalMs = 60_000,
) {
  return render(
    <ProjectBoard
      arrivalsIntervalMs={arrivalsIntervalMs}
      boardClient={client}
      projectId="project-1"
      storage={storage}
    />,
  );
}

async function openItem(title = 'Show the board') {
  const row = await screen.findByRole('button', { name: new RegExp(title) });
  await userEvent.click(row);
  return row;
}

test('shows the agreed honest empty state on first use', async () => {
  renderBoard(createClient({ list: async () => page([]) }));

  expect(
    await screen.findByText(
      'Nothing is on this board yet. Add your first work item to get started.',
    ),
  ).toBeTruthy();
  expect(
    screen.getAllByRole('button', { name: 'Add work item' }).length,
  ).toBeGreaterThan(0);
});

test('reports a failed board read and recovers with Try again', async () => {
  let calls = 0;
  renderBoard(
    createClient({
      list: async () => {
        calls += 1;
        if (calls === 1) throw new Error('down');
        return page([workItem]);
      },
    }),
  );

  expect(
    await screen.findByText('Cerebra couldn’t load this board. Try again.'),
  ).toBeTruthy();
  expect(screen.queryByText(/Nothing is on this board yet/)).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(
    await screen.findByRole('button', { name: /Show the board/ }),
  ).toBeTruthy();
});

test('adds work in place and announces it', async () => {
  const user = userEvent.setup();
  let listed: readonly WorkItem[] = [workItem];
  renderBoard(
    createClient({
      create: async (_projectId, input) => {
        const item = { ...workItem, id: 'item-2', title: input.title };
        listed = [item, workItem];
        return item;
      },
      list: async () => page(listed),
    }),
  );

  await screen.findByRole('button', { name: /Show the board/ });
  await user.click(screen.getByRole('button', { name: 'Add work item' }));
  expect(screen.getByText('New work item')).toBeTruthy();
  await user.type(
    screen.getByLabelText('What needs to change?'),
    'Keep the board stable',
  );
  await user.click(
    within(screen.getByRole('form', { name: 'New work item' })).getByRole(
      'button',
      { name: 'Add work item' },
    ),
  );

  expect(
    await screen.findByText('Work item added. It is ready for you to review.'),
  ).toBeTruthy();
  expect(
    await screen.findByRole('heading', { name: 'Keep the board stable' }),
  ).toBeTruthy();
  expect(
    screen.getByRole('button', { name: /Keep the board stable/ }),
  ).toBeTruthy();
});

test('keeps entered details when saving fails and retries with Try again', async () => {
  const user = userEvent.setup();
  let attempts = 0;
  renderBoard(
    createClient({
      create: async (_projectId, input) => {
        attempts += 1;
        if (attempts === 1) throw new Error('down');
        return { ...workItem, id: 'item-2', title: input.title };
      },
    }),
  );

  await screen.findByRole('button', { name: /Show the board/ });
  await user.click(screen.getByRole('button', { name: 'Add work item' }));
  await user.type(screen.getByLabelText('What needs to change?'), 'Draft');
  await user.type(screen.getByLabelText(/Optional/), 'Context');
  await user.click(
    within(screen.getByRole('form', { name: 'New work item' })).getByRole(
      'button',
      { name: 'Add work item' },
    ),
  );

  expect(
    await screen.findByText('Cerebra couldn’t save your changes. Try again.'),
  ).toBeTruthy();
  expect(
    (screen.getByLabelText('What needs to change?') as HTMLInputElement).value,
  ).toBe('Draft');
  expect((screen.getByLabelText(/Optional/) as HTMLTextAreaElement).value).toBe(
    'Context',
  );
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(
    await screen.findByText('Work item added. It is ready for you to review.'),
  ).toBeTruthy();
  expect(attempts).toBe(2);
});

test('triages the selected item in place', async () => {
  const user = userEvent.setup();
  const calls: unknown[] = [];
  renderBoard(
    createClient({
      triage: async (itemId, priority, route) => {
        calls.push({ itemId, priority, route });
        return { ...workItem, priority, state: route };
      },
    }),
  );

  await openItem();
  expect(screen.getByRole('heading', { name: 'Review new work' })).toBeTruthy();
  await user.click(screen.getByRole('radio', { name: 'P1' }));
  await user.click(screen.getByRole('radio', { name: /Send to build/ }));
  await user.click(
    screen.getByRole('button', { name: 'Set priority and continue' }),
  );

  expect(
    await screen.findByText('Priority and next step updated.'),
  ).toBeTruthy();
  expect(calls).toEqual([
    { itemId: 'item-1', priority: 'P1', route: 'build_ready' },
  ]);
  expect(screen.queryByRole('heading', { name: 'Review new work' })).toBeNull();
});

test('refuses a route the project does not support and keeps the work unchanged', async () => {
  const user = userEvent.setup();
  renderBoard(
    createClient({
      triage: async () => {
        throw new BoardRequestError(
          'That next step is not available for this project.',
          'route_unavailable',
        );
      },
    }),
  );

  await openItem();
  await user.click(screen.getByRole('radio', { name: 'P3' }));
  await user.click(screen.getByRole('radio', { name: /Send to design/ }));
  await user.click(
    screen.getByRole('button', { name: 'Set priority and continue' }),
  );

  expect(
    await screen.findByText(
      'That next step is not available for this project. Choose another route.',
    ),
  ).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Review new work' })).toBeTruthy();
  expect(
    (screen.getByRole('radio', { name: 'P3' }) as HTMLInputElement).checked,
  ).toBe(true);
  expect(screen.getAllByText('Needs triage').length).toBeGreaterThan(0);
});

test('keeps discussion and history on separate tabs', async () => {
  const user = userEvent.setup();
  renderBoard(
    createClient({
      history: async () => [
        {
          actorRole: 'navigator',
          createdAt: '2026-09-29T00:00:00.000Z',
          fromState: 'new',
          reason: null,
          toState: 'build_ready',
        },
      ],
    }),
  );

  await openItem();
  expect(
    screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected'),
  ).toBe('true');

  await user.click(screen.getByRole('tab', { name: 'Discussion' }));
  expect(await screen.findByText('No discussion yet.')).toBeTruthy();
  await user.type(screen.getByLabelText('Add a comment'), 'Looks right');
  await user.click(screen.getByRole('button', { name: 'Post comment' }));
  expect(await screen.findByText('Looks right')).toBeTruthy();
  expect(screen.queryByText('No discussion yet.')).toBeNull();

  await user.click(screen.getByRole('tab', { name: 'History' }));
  expect(await screen.findByText('Needs triage → Build ready')).toBeTruthy();
  expect(screen.queryByText('Looks right')).toBeNull();
});

test('shows empty history and a failed discussion read without hiding the board', async () => {
  const user = userEvent.setup();
  renderBoard(
    createClient({
      comments: async () => {
        throw new Error('down');
      },
    }),
  );

  await openItem();
  await user.click(screen.getByRole('tab', { name: 'History' }));
  expect(
    await screen.findByText('No changes have been recorded yet.'),
  ).toBeTruthy();
  await user.click(screen.getByRole('tab', { name: 'Discussion' }));
  expect(
    await screen.findByText(
      'Cerebra couldn’t load this discussion. Try again.',
    ),
  ).toBeTruthy();
  expect(screen.queryByText('No discussion yet.')).toBeNull();
  expect(screen.getByRole('button', { name: /Show the board/ })).toBeTruthy();
});

test('confirms cancellation with managed focus', async () => {
  const user = userEvent.setup();
  let listed: readonly WorkItem[] = [workItem];
  renderBoard(
    createClient({
      cancel: async () => {
        const cancelled = { ...workItem, state: 'cancelled' };
        listed = [cancelled];
        return cancelled;
      },
      list: async () => page(listed),
    }),
  );

  await openItem();
  const cancelControl = screen.getByRole('button', {
    name: 'Cancel this work item',
  });
  await user.click(cancelControl);
  const dialog = screen.getByRole('dialog');
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Cancel this work item' }),
    ),
  );
  expect(dialog).toBeTruthy();

  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(cancelControl));
  expect(screen.getByRole('heading', { name: 'Show the board' })).toBeTruthy();

  await user.click(cancelControl);
  await user.click(screen.getByRole('button', { name: 'Keep work item' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(cancelControl));

  await user.click(cancelControl);
  await user.click(screen.getByRole('button', { name: 'Cancel work item' }));
  const row = await screen.findByRole('button', {
    name: /Show the board.*Cancelled/,
  });
  expect(screen.queryByRole('heading', { name: 'Show the board' })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(row));
});

test('closes the detail with Close, Escape or Back to board and returns focus to the row', async () => {
  const user = userEvent.setup();
  renderBoard(createClient());

  let row = await openItem();
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('heading', { name: 'Show the board' })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(row));

  row = await openItem();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('heading', { name: 'Show the board' })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(row));

  row = await openItem();
  await user.click(screen.getByRole('button', { name: 'Back to board' }));
  expect(screen.queryByRole('heading', { name: 'Show the board' })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(row));

  row = await openItem();
  await user.click(screen.getByRole('button', { name: 'Save for later' }));
  expect(screen.queryByRole('heading', { name: 'Show the board' })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(row));
});

test('remembers search, filters and sort after a reload and clears them', async () => {
  const user = userEvent.setup();
  const storage = memoryStorage();
  const requests: BoardFilters[] = [];
  const client = createClient({
    list: async (_projectId, filters) => {
      requests.push(filters);
      return filters.search === '' && filters.state === ''
        ? page([workItem])
        : page([]);
    },
  });
  const first = renderBoard(client, storage);

  await screen.findByRole('button', { name: /Show the board/ });
  await user.type(
    screen.getByRole('searchbox', { name: 'Search work items' }),
    'zebra',
  );
  await user.selectOptions(
    screen.getByLabelText('Filter by state'),
    'build_ready',
  );
  await user.selectOptions(screen.getByLabelText('Filter by priority'), 'P1');
  await user.selectOptions(screen.getByLabelText('Sort work items'), 'oldest');
  expect(
    await screen.findByText('No work items match these filters.'),
  ).toBeTruthy();
  first.unmount();

  requests.length = 0;
  renderBoard(client, storage);
  expect(
    await screen.findByText('No work items match these filters.'),
  ).toBeTruthy();
  expect(
    (
      screen.getByRole('searchbox', {
        name: 'Search work items',
      }) as HTMLInputElement
    ).value,
  ).toBe('zebra');
  expect(requests[0]).toEqual({
    priority: 'P1',
    search: 'zebra',
    sort: 'oldest',
    state: 'build_ready',
  });

  await user.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(
    await screen.findByRole('button', { name: /Show the board/ }),
  ).toBeTruthy();
  expect(
    (screen.getByLabelText('Filter by state') as HTMLSelectElement).value,
  ).toBe('');
});

test('loads more work items on request', async () => {
  const user = userEvent.setup();
  const second = { ...workItem, id: 'item-2', title: 'Second item' };
  let release: () => void = () => undefined;
  renderBoard(
    createClient({
      list: async (_projectId, _filters, next) => {
        if (next === undefined) {
          return page([workItem], { nextCursor: '1', snapshot: '9', total: 2 });
        }
        expect(next).toEqual({ cursor: '1', snapshot: '9' });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return page([second], { snapshot: '9', total: 2 });
      },
    }),
  );

  await user.click(
    await screen.findByRole('button', { name: 'Show more work items' }),
  );
  expect(await screen.findByText('Loading more work items…')).toBeTruthy();
  release();
  expect(
    await screen.findByRole('button', { name: /Second item/ }),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: /Show the board/ })).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'Show more work items' }),
  ).toBeNull();
});

test('announces matching arrivals without moving the list until refreshed', async () => {
  const user = userEvent.setup();
  const arrival = { ...workItem, id: 'item-3', title: 'Arrived later' };
  let listed: readonly WorkItem[] = [workItem];
  renderBoard(
    createClient({
      arrivals: async (_projectId, _filters, snapshot) => {
        expect(snapshot).toBe('1');
        listed = [arrival, workItem];
        return 1;
      },
      list: async () => page(listed),
    }),
    memoryStorage(),
    20,
  );

  await screen.findByRole('button', { name: /Show the board/ });
  expect(await screen.findByText(/1 new work item/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Arrived later/ })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Refresh list' }));
  expect(
    await screen.findByRole('button', { name: /Arrived later/ }),
  ).toBeTruthy();
});

test('sits inside the application page as a section under its heading', async () => {
  renderBoard(createClient());

  expect(
    await screen.findByRole('heading', { level: 2, name: 'Project board' }),
  ).toBeTruthy();
  expect(screen.queryByRole('main')).toBeNull();
});

test('ignores a late read for an item that is no longer selected', async () => {
  const user = userEvent.setup();
  const other = { ...workItem, id: 'item-2', title: 'Other item' };
  let releaseFirst: () => void = () => undefined;
  renderBoard(
    createClient({
      history: async (itemId) => {
        if (itemId === 'item-2') return [];
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return [
          {
            actorRole: 'navigator',
            createdAt: '2026-09-29T00:00:00.000Z',
            fromState: 'new',
            reason: null,
            toState: 'build_ready',
          },
        ];
      },
      item: async (itemId) => (itemId === 'item-2' ? other : workItem),
      list: async () => page([workItem, other]),
    }),
  );

  await openItem();
  await user.click(screen.getByRole('tab', { name: 'History' }));
  await openItem('Other item');
  await user.click(screen.getByRole('tab', { name: 'History' }));
  expect(
    await screen.findByText('No changes have been recorded yet.'),
  ).toBeTruthy();
  releaseFirst();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByText('Needs triage → Build ready')).toBeNull();
  expect(screen.getByText('No changes have been recorded yet.')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Other item' })).toBeTruthy();
});

test('drops remembered filters that are no longer valid', async () => {
  const storage = memoryStorage();
  storage.setItem(
    'cerebra.board.project-1',
    JSON.stringify({
      priority: 'P9',
      search: 'zebra',
      sort: 'oldest',
      state: 'renamed_state',
    }),
  );
  const requests: BoardFilters[] = [];
  renderBoard(
    createClient({
      list: async (_projectId, filters) => {
        requests.push(filters);
        return page([]);
      },
    }),
    storage,
  );

  await screen.findByText('No work items match these filters.');
  expect(requests[0]).toEqual({
    priority: '',
    search: 'zebra',
    sort: 'oldest',
    state: '',
  });
});

test('loads more with the filters the list was loaded with', async () => {
  const user = userEvent.setup();
  const more: BoardFilters[] = [];
  renderBoard(
    createClient({
      list: async (_projectId, filters, next) => {
        if (next === undefined) {
          return page([workItem], { nextCursor: '1', snapshot: '9', total: 2 });
        }
        more.push(filters);
        return page([], { snapshot: '9', total: 2 });
      },
    }),
  );

  const button = await screen.findByRole('button', {
    name: 'Show more work items',
  });
  await user.type(
    screen.getByRole('searchbox', { name: 'Search work items' }),
    'z',
  );
  await user.click(button);
  await waitFor(() => expect(more.length).toBe(1));
  expect(more[0]?.search).toBe('');
});
