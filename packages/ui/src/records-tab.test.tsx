import {
  act,
  cleanup,
  render as renderPlain,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { MockupLocatorContext, type LocateMockup } from './mockups';
import {
  RecordsTab,
  type RecordsClient,
  type StageRecords,
} from './records-tab';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function render(
  ui: ReactElement,
  locate: LocateMockup = async (id) => `http://localhost:4318/mockups/${id}`,
) {
  return renderPlain(
    <MockupLocatorContext.Provider value={locate}>
      {ui}
    </MockupLocatorContext.Provider>,
  );
}

const year = new Date().getFullYear();

const outcomeMarkdown = [
  '## Outcome',
  'Any filtered invoice list can be downloaded as a CSV.',
  '## Route',
  'design',
].join('\n');

const design = (experience: string, drawing = 'A · Download above the list') =>
  [
    '## The agreed experience',
    experience,
    '## The states',
    'Empty list: button disabled, “No invoices to export.”',
    '## The words, exactly',
    '“Download CSV”',
    '## What was considered and rejected',
    'An export dialog with column picking.',
    '## The mockup',
    drawing,
  ].join('\n');

const outcome = {
  kind: 'outcome' as const,
  versions: [
    {
      agentName: 'Jubilee',
      at: `${year}-09-20T12:00:00.000Z`,
      id: '1',
      markdown: outcomeMarkdown,
      mockupId: null,
      version: 1,
    },
  ],
};

const version1 = {
  agentName: 'Iris',
  at: `${year}-09-24T12:00:00.000Z`,
  id: '2',
  markdown: design('A “Download CSV” button exports what is filtered.'),
  mockupId: 'mockup-1',
  version: 1,
};
const version2 = {
  agentName: 'Iris',
  at: `${year}-09-29T12:00:00.000Z`,
  id: '3',
  markdown: design('A “Download CSV” button above the invoice list.'),
  mockupId: 'mockup-2',
  version: 2,
};

const both = (...versions: (typeof version1)[]): StageRecords => ({
  records: [outcome, { kind: 'design', versions }],
});

function client(
  ...answers: (StageRecords | Error)[]
): RecordsClient & { readonly reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    read: async (itemId) => {
      reads.push(itemId);
      const next = answers.length > 1 ? answers.shift()! : answers[0]!;
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test('says there are no records yet, never as a failure', async () => {
  render(<RecordsTab client={client({ records: [] })} itemId="item-1" />);

  expect(
    await screen.findByText(
      'No records yet. Each step writes one here as it finishes.',
    ),
  ).toBeTruthy();
  expect(screen.queryByRole('region')).toBeNull();
});

test('shows only the agreed outcome until a design is agreed, every heading open', async () => {
  const reads = client({ records: [outcome] });
  render(<RecordsTab client={reads} itemId="item-1" />);

  const shown = await screen.findByRole('region', { name: 'Agreed outcome' });
  expect(screen.queryByRole('region', { name: 'Agreed design' })).toBeNull();
  expect(
    within(shown).getByText(
      'Any filtered invoice list can be downloaded as a CSV.',
    ),
  ).toBeTruthy();
  const heading = within(shown).getByRole('button', { name: 'Outcome' });
  expect(heading.getAttribute('aria-expanded')).toBe('true');
  expect(
    within(shown).getByRole('button', { name: 'Version 1 ▾' }),
  ).toBeTruthy();
  expect(reads.reads).toEqual(['item-1']);
});

test('shows the outcome, then the design with its chosen drawing, in full', async () => {
  const user = userEvent.setup();
  render(<RecordsTab client={client(both(version1))} itemId="item-1" />);

  const shown = await screen.findByRole('region', { name: 'Agreed design' });
  expect(screen.getAllByRole('region')).toHaveLength(2);
  expect(
    screen
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent),
  ).toEqual(['Agreed outcome', 'Agreed design']);
  expect(
    within(shown)
      .getAllByRole('button', { expanded: true })
      .map((button) => button.textContent?.replace('▾', '')),
  ).toEqual([
    'The agreed experience',
    'The states',
    'The words, exactly',
    'What was considered and rejected',
    'The drawing',
  ]);
  expect(
    within(shown).getByText(
      'A “Download CSV” button exports what is filtered.',
    ),
  ).toBeTruthy();
  expect(within(shown).getByText('A · Download above the list')).toBeTruthy();
  expect(
    shown.querySelector('iframe[src="http://localhost:4318/mockups/mockup-1"]'),
  ).not.toBeNull();

  const open = within(shown).getByRole('button', { name: 'Open full size' });
  await user.click(open);
  const dialog = screen.getByRole('dialog', {
    name: 'A · Download above the list',
  });
  expect(within(dialog).getByText('1 of 1')).toBeTruthy();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(open);
});

test('collapses and opens a heading', async () => {
  const user = userEvent.setup();
  render(<RecordsTab client={client(both(version1))} itemId="item-1" />);

  const shown = await screen.findByRole('region', { name: 'Agreed design' });
  const states = within(shown).getByRole('button', { name: 'The states' });
  const body = within(shown).getByText(
    'Empty list: button disabled, “No invoices to export.”',
  );
  await user.click(states);
  expect(states.getAttribute('aria-expanded')).toBe('false');
  expect(body.closest('[hidden]')).not.toBeNull();
  await user.click(states);
  expect(states.getAttribute('aria-expanded')).toBe('true');
  expect(body.closest('[hidden]')).toBeNull();
});

test('lists every version newest first and shows an earlier one until Show current', async () => {
  const user = userEvent.setup();
  render(
    <RecordsTab client={client(both(version1, version2))} itemId="item-1" />,
  );

  const shown = await screen.findByRole('region', { name: 'Agreed design' });
  expect(
    within(shown).getByText('A “Download CSV” button above the invoice list.'),
  ).toBeTruthy();
  const menuButton = within(shown).getByRole('button', {
    name: 'Version 2 ▾',
  });
  menuButton.focus();
  await user.keyboard('{Enter}');
  const menu = screen.getByRole('menu');
  expect(
    within(menu)
      .getAllByRole('menuitemradio')
      .map((item) => item.textContent),
  ).toEqual(['✓Version 2 · 29 Sep · current', 'Version 1 · 24 Sep']);

  await waitFor(() =>
    expect(document.activeElement?.textContent).toContain('Version 2'),
  );
  await user.keyboard('{ArrowDown}{Enter}');
  expect(screen.queryByRole('menu')).toBeNull();
  expect(
    within(shown).getByText(
      'A “Download CSV” button exports what is filtered.',
    ),
  ).toBeTruthy();
  expect(
    shown.querySelector('iframe[src="http://localhost:4318/mockups/mockup-1"]'),
  ).not.toBeNull();
  expect(
    within(shown).getByText('You are looking at an earlier version.'),
  ).toBeTruthy();
  expect(
    within(shown).getByRole('button', { name: 'Version 1 ▾' }),
  ).toBeTruthy();

  await user.click(within(shown).getByRole('button', { name: 'Show current' }));
  expect(
    within(shown).getByText('A “Download CSV” button above the invoice list.'),
  ).toBeTruthy();
  expect(
    within(shown).queryByText('You are looking at an earlier version.'),
  ).toBeNull();
});

test('Escape closes the version menu and returns focus to its button', async () => {
  const user = userEvent.setup();
  render(
    <RecordsTab client={client(both(version1, version2))} itemId="item-1" />,
  );

  const shown = await screen.findByRole('region', { name: 'Agreed design' });
  const menuButton = within(shown).getByRole('button', {
    name: 'Version 2 ▾',
  });
  await user.click(menuButton);
  expect(screen.getByRole('menu')).toBeTruthy();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(menuButton);
});

test('a first read that fails says so on each card and tries again', async () => {
  const user = userEvent.setup();
  const reads = client(new Error('down'), both(version1));
  render(<RecordsTab client={reads} itemId="item-1" />);

  expect(
    await screen.findByText(
      'Cerebra couldn’t load the agreed outcome. Try again.',
    ),
  ).toBeTruthy();
  expect(
    screen.getByText('Cerebra couldn’t load the agreed design. Try again.'),
  ).toBeTruthy();
  expect(
    screen.queryByText(
      'No records yet. Each step writes one here as it finishes.',
    ),
  ).toBeNull();

  await user.click(screen.getAllByRole('button', { name: 'Try again' })[1]!);
  expect(
    await screen.findByText(
      'A “Download CSV” button exports what is filtered.',
    ),
  ).toBeTruthy();
  expect(reads.reads).toHaveLength(2);
});

test('a drawing that fails to load leaves the written design and offers to try again', async () => {
  const locate = vi.fn<LocateMockup>(async () => {
    throw new Error('gone');
  });
  render(
    <RecordsTab client={client(both(version1))} itemId="item-1" />,
    locate,
  );

  const shown = await screen.findByRole('region', { name: 'Agreed design' });
  expect(
    await within(shown).findByText(
      'Cerebra couldn’t load the chosen drawing. Try again.',
    ),
  ).toBeTruthy();
  expect(
    within(shown).getByText(
      'A “Download CSV” button exports what is filtered.',
    ),
  ).toBeTruthy();
  const calls = locate.mock.calls.length;
  await userEvent
    .setup()
    .click(within(shown).getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(locate.mock.calls.length).toBeGreaterThan(calls));
});

test('a design recorded before drawings were kept shows its drawing’s name only', async () => {
  render(
    <RecordsTab
      client={client(both({ ...version1, mockupId: null }))}
      itemId="item-1"
    />,
  );

  const shown = await screen.findByRole('region', { name: 'Agreed design' });
  expect(within(shown).getByText('A · Download above the list')).toBeTruthy();
  expect(
    within(shown).queryByRole('button', { name: 'Open full size' }),
  ).toBeNull();
  expect(shown.querySelector('iframe')).toBeNull();
});

test('shows a neutral placeholder before anything is read, then Loading… beside the cards', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let answer: (records: StageRecords) => void = () => {};
  let calls = 0;
  const slow: RecordsClient = {
    read: () => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(both(version1))
        : new Promise((resolve) => {
            answer = resolve;
          });
    },
  };
  const pending: RecordsClient = { read: () => new Promise(() => {}) };
  const { unmount } = render(<RecordsTab client={pending} itemId="item-1" />);
  expect(screen.getByText('Loading…')).toBeTruthy();
  expect(screen.queryByRole('region')).toBeNull();
  unmount();

  render(<RecordsTab client={slow} intervalMs={1000} itemId="item-1" />);
  await screen.findByRole('region', { name: 'Agreed design' });
  expect(screen.queryByText('Loading…')).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(screen.getByText('Loading…')).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Agreed design' })).toBeTruthy();
  await act(async () => {
    answer(both(version1));
  });
  expect(screen.queryByText('Loading…')).toBeNull();
});

test('a version confirmed while the tab is open becomes current without moving what is read', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(
    <RecordsTab
      client={client(both(version1), both(version1, version2))}
      intervalMs={1000}
      itemId="item-1"
    />,
  );

  const shown = await screen.findByRole('region', { name: 'Agreed design' });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });

  expect(
    within(shown).getByText(
      'A “Download CSV” button exports what is filtered.',
    ),
  ).toBeTruthy();
  expect(
    within(shown).getByText('You are looking at an earlier version.'),
  ).toBeTruthy();
  await user.click(within(shown).getByRole('button', { name: 'Version 1 ▾' }));
  expect(
    within(screen.getByRole('menu'))
      .getAllByRole('menuitemradio')
      .map((item) => item.textContent),
  ).toEqual(['Version 2 · 29 Sep · current', '✓Version 1 · 24 Sep']);
});

test('a refresh that fails keeps the records shown', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(
    <RecordsTab
      client={client(both(version1), new Error('down'))}
      intervalMs={1000}
      itemId="item-1"
    />,
  );

  await screen.findByRole('region', { name: 'Agreed design' });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(screen.getByRole('region', { name: 'Agreed design' })).toBeTruthy();
  expect(
    screen.queryByText('Cerebra couldn’t load the agreed design. Try again.'),
  ).toBeNull();
});

test('dates a version of another year with its year', async () => {
  const user = userEvent.setup();
  render(
    <RecordsTab
      client={client(
        both({ ...version1, at: `${year - 1}-09-24T12:00:00.000Z` }, version2),
      )}
      itemId="item-1"
    />,
  );

  const shown = await screen.findByRole('region', { name: 'Agreed design' });
  await user.click(within(shown).getByRole('button', { name: 'Version 2 ▾' }));
  expect(
    within(screen.getByRole('menu')).getByText(
      `Version 1 · 24 Sep ${year - 1}`,
    ),
  ).toBeTruthy();
});
