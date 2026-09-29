import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { CostClient } from './costs';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';

import {
  BoardRequestError,
  type BoardClient,
  type BoardFilters,
  type BoardPage,
  type WorkItem,
} from './board';
import type {
  AutomaticStartStatus,
  AutomaticStartsClient,
} from './automatic-starts';
import type { DeliveryActivityClient } from './delivery-activity';
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

const running: AutomaticStartStatus = {
  limit: 3,
  paused: false,
  running: 2,
  waiting: [],
};

function startsClient(
  overrides: Partial<AutomaticStartsClient> = {},
): AutomaticStartsClient {
  const unused = async () => {
    throw new Error('Not exercised');
  };
  return {
    limits: unused,
    saveInstanceLimit: unused,
    saveProjectLimit: unused,
    setPaused: async () => undefined,
    status: async () => running,
    ...overrides,
  };
}

const noCosts: CostClient = {
  forItem: async () => ({ runs: [], totalUsd: 0 }),
  forProject: async () => ({
    notLinkedUsd: 0,
    runs: [],
    totalUsd: 0,
    workItemsUsd: 0,
  }),
};

function renderBoard(
  client: BoardClient,
  storage = memoryStorage(),
  arrivalsIntervalMs = 60_000,
  automaticStarts = startsClient(),
  costClient = noCosts,
) {
  return render(
    <ProjectBoard
      arrivalsIntervalMs={arrivalsIntervalMs}
      automaticStartsClient={automaticStarts}
      boardClient={client}
      costClient={costClient}
      projectId="project-1"
      storage={storage}
    />,
  );
}

test("shows the project's cost beside its work, and an item's cost in its overview", async () => {
  const costs: CostClient = {
    forItem: async (itemId) => ({
      runs: [
        {
          agentName: 'Rogue',
          costUsd: 1.5,
          id: 'run-1',
          role: 'builder',
          startedAt: '2026-10-01T09:00:00.000Z',
          state: 'finished',
        },
      ],
      totalUsd: itemId === 'item-1' ? 1.5 : 0,
    }),
    forProject: async () => ({
      notLinkedUsd: 0.25,
      runs: [],
      totalUsd: 1.75,
      workItemsUsd: 1.5,
    }),
  };
  renderBoard(createClient(), memoryStorage(), 60_000, startsClient(), costs);

  expect(await screen.findByText('$1.75')).toBeTruthy();
  await openItem();
  const overview = screen.getByRole('tabpanel');
  const cost = within(overview).getByRole('region', { name: 'Cost so far' });
  expect(await within(cost).findByText('$1.50')).toBeTruthy();
});

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

test('opens an item on the tab another view asked for', async () => {
  const comments: string[] = [];
  const { rerender } = render(
    <ProjectBoard
      boardClient={createClient({
        comments: async (itemId) => {
          comments.push(itemId);
          return [];
        },
      })}
      openRequest={{ id: 'item-1', tab: 'discussion' }}
      projectId="project-1"
      storage={memoryStorage()}
    />,
  );

  expect(
    await screen.findByRole('heading', { name: 'Show the board' }),
  ).toBeTruthy();
  expect(
    screen
      .getByRole('tab', { name: 'Discussion' })
      .getAttribute('aria-selected'),
  ).toBe('true');
  expect(await screen.findByText('No discussion yet.')).toBeTruthy();
  expect(comments).toEqual(['item-1']);

  rerender(
    <ProjectBoard
      boardClient={createClient()}
      openRequest={{ id: 'item-1', tab: 'overview' }}
      projectId="project-1"
      storage={memoryStorage()}
    />,
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole('tab', { name: 'Overview' })
        .getAttribute('aria-selected'),
    ).toBe('true'),
  );
});

const readyItems: readonly WorkItem[] = [
  {
    ...workItem,
    id: 'ready-1',
    priority: 'P1',
    state: 'build_ready',
    title: 'Make reports easier to share',
  },
  {
    ...workItem,
    id: 'ready-2',
    priority: 'P2',
    state: 'build_ready',
    title: 'Fix export timeout',
  },
  {
    ...workItem,
    id: 'ready-3',
    priority: 'P2',
    state: 'design_ready',
    title: 'Add dark theme to settings',
  },
  {
    ...workItem,
    id: 'ready-4',
    priority: 'P2',
    state: 'build_ready',
    title: 'Upgrade build tools',
  },
  { ...workItem, id: 'new-1', title: 'Clean up login copy' },
];

test('shows automatic starts in the header and why each ready item waits', async () => {
  renderBoard(
    createClient({ list: async () => page(readyItems) }),
    memoryStorage(),
    60_000,
    startsClient({
      status: async () => ({
        ...running,
        waiting: [
          {
            itemId: 'ready-1',
            reason: { kind: 'project_limit', limit: 3, running: 3 },
          },
          {
            itemId: 'ready-2',
            reason: { kind: 'no_free_agent', role: 'producer' },
          },
          {
            itemId: 'ready-3',
            reason: { kind: 'instance_limit', limit: 6, running: 6 },
          },
          {
            itemId: 'ready-4',
            reason: { kind: 'credential_missing', service: 'GitHub' },
          },
        ],
      }),
    }),
  );

  expect(
    await screen.findByText('Starting work automatically · 2 of 3 running'),
  ).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Pause automatic starts' }),
  ).toBeTruthy();
  expect(
    await screen.findByRole('button', {
      description: 'Waiting — project limit reached (3 of 3 running)',
      name: /Make reports easier to share/,
    }),
  ).toBeTruthy();
  expect(
    screen.getByText('Waiting — project limit reached (3 of 3 running)'),
  ).toBeTruthy();
  expect(screen.getByText('Waiting — no producer is free')).toBeTruthy();
  expect(
    screen.getByText('Waiting — Cerebra-wide limit reached (6 of 6 running)'),
  ).toBeTruthy();
  expect(
    screen.getByText("Can't start — GitHub credential missing"),
  ).toBeTruthy();
  expect(
    screen.getByRole('link', { name: 'Fix in settings' }).getAttribute('href'),
  ).toBe('#/settings/credentials');
  expect(
    screen
      .getByRole('button', { name: /Clean up login copy/ })
      .getAttribute('aria-describedby'),
  ).toBeNull();
});

test('pauses at once, shows the banner and moves focus between the controls', async () => {
  const calls: boolean[] = [];
  let paused = false;
  renderBoard(
    createClient({ list: async () => page(readyItems.slice(0, 1)) }),
    memoryStorage(),
    60_000,
    startsClient({
      setPaused: async (_projectId, value) => {
        calls.push(value);
        paused = value;
      },
      status: async () => ({
        ...running,
        paused,
        waiting: paused
          ? [{ itemId: 'ready-1', reason: { kind: 'paused' } }]
          : [],
      }),
    }),
  );

  await userEvent.click(
    await screen.findByRole('button', { name: 'Pause automatic starts' }),
  );

  const resume = await screen.findByRole('button', { name: 'Resume' });
  expect(calls).toEqual([true]);
  expect(document.activeElement).toBe(resume);
  expect(screen.getByText('Automatic starts are paused.')).toBeTruthy();
  expect(
    screen.getByText(
      /Work already running continues, and you can still start anyone yourself from the fleet\./,
    ),
  ).toBeTruthy();
  expect(
    await screen.findByText('Waiting — automatic starts are paused'),
  ).toBeTruthy();
  expect(screen.queryByText(/Starting work automatically/)).toBeNull();

  await userEvent.click(resume);

  const pause = await screen.findByRole('button', {
    name: 'Pause automatic starts',
  });
  expect(calls).toEqual([true, false]);
  expect(document.activeElement).toBe(pause);
  expect(screen.queryByText('Automatic starts are paused.')).toBeNull();
});

test('says a failed pause or resume changed nothing and retries with Try again', async () => {
  let failing = true;
  let paused = false;
  renderBoard(
    createClient(),
    memoryStorage(),
    60_000,
    startsClient({
      setPaused: async (_projectId, value) => {
        if (failing) throw new Error('offline');
        paused = value;
      },
      status: async () => ({ ...running, paused }),
    }),
  );

  await userEvent.click(
    await screen.findByRole('button', { name: 'Pause automatic starts' }),
  );

  expect((await screen.findByRole('alert')).textContent).toContain(
    "Cerebra couldn't pause automatic starts. Nothing has changed.",
  );
  expect(
    screen.getByRole('button', { name: 'Pause automatic starts' }),
  ).toBeTruthy();
  expect(screen.queryByText('Automatic starts are paused.')).toBeNull();

  failing = false;
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

  expect(await screen.findByRole('button', { name: 'Resume' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();

  failing = true;
  await userEvent.click(screen.getByRole('button', { name: 'Resume' }));

  expect((await screen.findByRole('alert')).textContent).toContain(
    "Cerebra couldn't resume automatic starts. Nothing has changed.",
  );
  expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
});

test('never leaves a waiting reason blank when it could not be read', async () => {
  let failing = true;
  renderBoard(
    createClient({ list: async () => page(readyItems) }),
    memoryStorage(),
    60_000,
    startsClient({
      status: async () => {
        if (failing) throw new Error('offline');
        return {
          ...running,
          waiting: [
            {
              itemId: 'ready-2',
              reason: { kind: 'no_free_agent', role: 'producer' },
            },
          ],
        };
      },
    }),
  );

  expect(
    await screen.findByRole('button', {
      description: "Couldn't check why this is waiting",
      name: /Fix export timeout/,
    }),
  ).toBeTruthy();
  expect(
    screen.getAllByText("Couldn't check why this is waiting"),
  ).toHaveLength(4);
  expect(
    screen
      .getByRole('button', { name: /Clean up login copy/ })
      .getAttribute('aria-describedby'),
  ).toBeNull();
  expect(screen.queryByText(/Starting work automatically/)).toBeNull();

  failing = false;
  await userEvent.click(
    screen.getAllByRole('button', { name: 'Try again' })[0]!,
  );

  expect(await screen.findByText('Waiting — no producer is free')).toBeTruthy();
  expect(screen.queryByText("Couldn't check why this is waiting")).toBeNull();
  expect(
    screen.getByText('Starting work automatically · 2 of 3 running'),
  ).toBeTruthy();
});

test('shows no chips when nothing waits and follows conditions as they change', async () => {
  let waiting: AutomaticStartStatus['waiting'] = [];
  render(
    <ProjectBoard
      arrivalsIntervalMs={60_000}
      automaticStartsClient={startsClient({
        status: async () => ({ ...running, waiting }),
      })}
      boardClient={createClient({
        list: async () => page(readyItems.slice(0, 1)),
      })}
      projectId="project-1"
      statusIntervalMs={50}
      storage={memoryStorage()}
    />,
  );

  expect(
    await screen.findByText('Starting work automatically · 2 of 3 running'),
  ).toBeTruthy();
  await screen.findByRole('button', { name: /Make reports easier to share/ });
  expect(screen.queryByText(/Waiting —/)).toBeNull();

  waiting = [
    {
      itemId: 'ready-1',
      reason: { kind: 'project_limit', limit: 3, running: 3 },
    },
  ];

  expect(
    await screen.findByText('Waiting — project limit reached (3 of 3 running)'),
  ).toBeTruthy();
});

test('says under each title who filed it and links to the item it came from', async () => {
  const opened: string[] = [];
  const items: WorkItem[] = [
    {
      ...workItem,
      filedBy: {
        agentName: 'Gale',
        discoveredFrom: { id: 'item-9', title: 'Export invoices as CSV' },
        role: 'groomer',
      },
      id: 'item-2',
      title: 'Bulk export for credit notes',
    },
    {
      ...workItem,
      filedBy: { agentName: 'Astra', discoveredFrom: null, role: 'assistant' },
      id: 'item-3',
      title: 'Dark mode for printed invoices',
    },
    { ...workItem, filedBy: null, id: 'item-4', title: 'Fix VAT rounding' },
  ];
  renderBoard(
    createClient({
      item: async (itemId) => {
        opened.push(itemId);
        return { ...workItem, id: itemId, title: 'Export invoices as CSV' };
      },
      list: async () => page(items),
    }),
  );

  expect(
    await screen.findByRole('button', {
      description: 'Filed by Gale while grooming Export invoices as CSV',
      name: /Bulk export for credit notes/,
    }),
  ).toBeTruthy();
  expect(
    screen.getByRole('button', {
      description: 'Filed by Astra in a conversation with you',
      name: /Dark mode for printed invoices/,
    }),
  ).toBeTruthy();
  expect(
    screen.getByRole('button', {
      description: 'Filed by you',
      name: /Fix VAT rounding/,
    }),
  ).toBeTruthy();

  await userEvent.click(
    screen.getByRole('button', { name: 'Export invoices as CSV' }),
  );
  await waitFor(() => expect(opened).toContain('item-9'));
});

const building: WorkItem = { ...workItem, state: 'building' };

function deliveryClient(): DeliveryActivityClient {
  return {
    read: async () => ({
      current: null,
      earlierCursor: null,
      events: [
        {
          agentName: 'Wolverine',
          at: '2026-10-04T10:14:00.000Z',
          id: '7',
          kind: 'plan',
          runId: 'run-1',
        },
      ],
      latestChecks: null,
      latestPullRequest: null,
    }),
  };
}

test('shows delivery activity on the Overview once work is in delivery', async () => {
  const client = createClient({
    item: async (id) => (id === 'item-1' ? building : workItem),
    list: async () =>
      page([building, { ...workItem, id: 'item-2', title: 'Triage me' }]),
  });
  render(
    <ProjectBoard
      automaticStartsClient={startsClient()}
      boardClient={client}
      deliveryClient={deliveryClient()}
      projectId="project-1"
      storage={memoryStorage()}
    />,
  );

  await openItem('Show the board');
  expect(
    await screen.findByRole('region', { name: 'Delivery activity' }),
  ).toBeTruthy();
  expect(await screen.findByText('Plan recorded')).toBeTruthy();

  await openItem('Triage me');
  await screen.findByRole('heading', { name: 'Review new work' });
  expect(
    screen.queryByRole('region', { name: 'Delivery activity' }),
  ).toBeNull();
});

test('reopens the item and refocuses the trail link after Back', async () => {
  window.history.replaceState(
    { cerebraDeliveryFocus: { itemId: 'item-1', linkId: 'delivery-link-7' } },
    '',
  );
  render(
    <ProjectBoard
      automaticStartsClient={startsClient()}
      boardClient={createClient({
        item: async () => building,
        list: async () => page([building]),
      })}
      deliveryClient={deliveryClient()}
      projectId="project-1"
      storage={memoryStorage()}
    />,
  );

  const link = await screen.findByRole('link', { name: 'Plan recorded' });
  await waitFor(() => expect(document.activeElement).toBe(link));
  expect(window.history.state).toMatchObject({ cerebraDeliveryFocus: null });
});
