import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import { ProjectCostCard, WorkItemCost } from './cost-summary';
import { formatUsd, type CostClient, type ItemCost } from './costs';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const run = {
  agentName: 'Rogue',
  costUsd: 1234.56,
  id: 'run-1',
  role: 'builder',
  startedAt: '2026-10-01T09:00:00.000Z',
  state: 'finished',
};

function client(overrides: Partial<CostClient> = {}): CostClient {
  return {
    forItem: async () => ({ runs: [run], totalUsd: 1234.56 }),
    forProject: async () => ({
      notLinkedUsd: 0.21,
      runs: [
        {
          ...run,
          costUsd: 2.15,
          item: { id: 'item-1', title: 'Share reports' },
        },
        {
          ...run,
          agentName: 'Cerebro',
          costUsd: 0.21,
          id: 'run-2',
          item: null,
        },
      ],
      totalUsd: 2.36,
      workItemsUsd: 2.15,
    }),
    ...overrides,
  };
}

test('amounts are full currency with separators and cents', () => {
  expect(formatUsd(1234.56)).toBe('$1,234.56');
  expect(formatUsd(0)).toBe('$0.00');
  expect(formatUsd(0.2)).toBe('$0.20');
});

test("a work item's cost so far opens its runs inline", async () => {
  const user = userEvent.setup();
  render(<WorkItemCost client={client()} itemId="item-1" />);

  const card = await screen.findByRole('region', { name: 'Cost so far' });
  expect(await within(card).findByText('$1,234.56')).toBeTruthy();
  expect(
    within(card).getByText(
      'Estimated API-price equivalent for Claude usage. This is not a subscription charge.',
    ),
  ).toBeTruthy();
  const toggle = within(card).getByRole('button', { name: 'See cost by run' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(within(card).queryByText('Rogue')).toBeNull();

  await user.click(toggle);

  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  const runs = within(card).getByRole('list', { name: 'Cost by run' });
  expect(within(runs).getByText('Rogue')).toBeTruthy();
  expect(within(runs).getByText('$1,234.56')).toBeTruthy();
});

test("a project's cost is split into work items and runs not linked to work", async () => {
  const user = userEvent.setup();
  render(<ProjectCostCard client={client()} projectId="project-1" />);

  const card = await screen.findByRole('region', { name: 'Cost so far' });
  expect(await within(card).findByText('$2.36')).toBeTruthy();
  expect(within(card).getByText('Work items')).toBeTruthy();
  expect(within(card).getByText('$2.15')).toBeTruthy();
  expect(within(card).getByText('Not linked to work')).toBeTruthy();
  expect(within(card).getByText('$0.21')).toBeTruthy();

  await user.click(
    within(card).getByRole('button', { name: 'See all cost details' }),
  );

  const runs = within(card).getByRole('list', { name: 'All cost details' });
  const rows = within(runs).getAllByRole('listitem');
  expect(rows[0]?.textContent).toContain('Share reports');
  expect(rows[1]?.textContent).toContain('Not linked to work');
  expect(rows[1]?.textContent).toContain('Cerebro');
});

test('nothing recorded says so for the work item and for the project', async () => {
  const empty = client({
    forItem: async () => ({ runs: [], totalUsd: 0 }),
    forProject: async () => ({
      notLinkedUsd: 0,
      runs: [],
      totalUsd: 0,
      workItemsUsd: 0,
    }),
  });
  render(
    <>
      <WorkItemCost client={empty} itemId="item-1" />
      <ProjectCostCard client={empty} projectId="project-1" />
    </>,
  );

  expect(
    await screen.findByText('No usage has been recorded for this work yet.'),
  ).toBeTruthy();
  expect(
    await screen.findByText('No usage has been recorded for this project yet.'),
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'See cost by run' })).toBeNull();
});

test('a cost that cannot load says so and can be tried again', async () => {
  const user = userEvent.setup();
  let fail = true;
  render(
    <WorkItemCost
      client={client({
        forItem: async () => {
          if (fail) throw new Error('down');
          return { runs: [run], totalUsd: 3 };
        },
      })}
      itemId="item-1"
    />,
  );

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe("We couldn't load the cost. Try again.");
  fail = false;
  await user.click(within(alert).getByRole('button', { name: 'Try again' }));

  expect(await screen.findByText('$3.00')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('while refreshing, the last total stays with Updating…', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let resolve: ((cost: ItemCost) => void) | undefined;
  let calls = 0;
  render(
    <WorkItemCost
      client={client({
        forItem: () => {
          calls += 1;
          if (calls === 1) return Promise.resolve({ runs: [run], totalUsd: 5 });
          return new Promise<ItemCost>((done) => {
            resolve = done;
          });
        },
      })}
      itemId="item-1"
      pollIntervalMs={1000}
    />,
  );
  expect(await screen.findByText('$5.00')).toBeTruthy();

  await act(async () => {
    vi.advanceTimersByTime(1000);
  });

  expect(screen.getByText('$5.00')).toBeTruthy();
  expect(screen.getByText('Updating…')).toBeTruthy();
  await act(async () => {
    resolve?.({ runs: [run], totalUsd: 6 });
  });
  expect(screen.getByText('$6.00')).toBeTruthy();
  expect(screen.queryByText('Updating…')).toBeNull();
});
