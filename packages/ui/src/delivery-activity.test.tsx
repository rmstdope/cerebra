import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import {
  DeliveryActivity,
  type DeliveryActivityClient,
  type DeliveryActivityPage,
  type DeliveryEvent,
} from './delivery-activity';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.history.replaceState(null, '');
});

const plan: DeliveryEvent = {
  agentName: 'Wolverine',
  at: '2026-10-04T10:14:00.000Z',
  id: '1',
  kind: 'plan',
  runId: 'run-1',
};
const passed: DeliveryEvent = {
  agentName: 'Wolverine',
  at: '2026-10-04T10:31:00.000Z',
  id: '2',
  kind: 'checks',
  passed: true,
  runId: 'run-1',
};
const failed: DeliveryEvent = { ...passed, id: '3', passed: false };
const pullRequest: DeliveryEvent = {
  agentName: 'Wolverine',
  at: '2026-10-04T10:34:00.000Z',
  id: '4',
  kind: 'pull_request',
  number: 482,
  runId: 'run-1',
  title: 'Let builders deliver work from plan to pull request',
  url: 'https://github.com/acme/website/pull/482',
};

function activity(
  events: readonly DeliveryEvent[],
  extra: Partial<DeliveryActivityPage> = {},
): DeliveryActivityPage {
  return {
    current: null,
    earlierCursor: null,
    events,
    latestChecks: null,
    latestPullRequest: null,
    ...extra,
  };
}

function client(
  read: DeliveryActivityClient['read'],
): DeliveryActivityClient & { reads: (string | undefined)[] } {
  const reads: (string | undefined)[] = [];
  return {
    reads,
    read: async (itemId, before) => {
      reads.push(before);
      return read(itemId, before);
    },
  };
}

function show(
  deliveryClient: DeliveryActivityClient,
  state = 'reviewing',
  intervalMs = 60_000,
) {
  return render(
    <DeliveryActivity
      client={deliveryClient}
      intervalMs={intervalMs}
      itemId="item-1"
      state={state}
    />,
  );
}

test('tells the delivery story oldest first, ending with what happens now', async () => {
  show(
    client(async () =>
      activity([plan, passed, pullRequest], {
        current: { kind: 'waiting_for_review', reviewer: 'Rogue' },
        latestChecks: passed as Extract<DeliveryEvent, { kind: 'checks' }>,
        latestPullRequest: pullRequest as Extract<
          DeliveryEvent,
          { kind: 'pull_request' }
        >,
      }),
    ),
  );

  const trail = await screen.findByRole('region', {
    name: 'Delivery activity',
  });
  const headings = await within(trail).findAllByRole('heading', { level: 4 });
  expect(headings.map((heading) => heading.textContent)).toEqual([
    'Plan recorded',
    'Checks passed',
    'Pull request opened',
    'Waiting for review',
  ]);
  expect(
    within(trail).getByText(
      'Wolverine set out how this change will be built and checked.',
    ),
  ).toBeTruthy();
  expect(
    within(trail).getByText('All required checks finished successfully.'),
  ).toBeTruthy();
  expect(
    within(trail).getByText(
      'Rogue will review the pull request next. Nothing is needed from you.',
    ),
  ).toBeTruthy();
  const planLink = within(trail).getByRole('link', { name: 'Plan recorded' });
  expect(planLink.getAttribute('href')).toBe('#/conversations/run-1');
  const pullLink = within(trail).getByRole('link', {
    name: '#482 Let builders deliver work from plan to pull request',
  });
  expect(pullLink.getAttribute('href')).toBe(
    'https://github.com/acme/website/pull/482',
  );
  for (const link of [planLink, pullLink]) {
    expect(link.getAttribute('target')).toBeNull();
  }

  const glance = screen.getByRole('complementary', { name: 'At a glance' });
  expect(within(glance).getByText('Reviewing')).toBeTruthy();
  expect(within(glance).getByText('Independent review')).toBeTruthy();
  expect(within(glance).getByRole('link', { name: '#482' })).toBeTruthy();
  expect(within(glance).getByText(/^Passed/)).toBeTruthy();
});

test('shows a loading placeholder, then the empty trail', async () => {
  let resolve: (value: DeliveryActivityPage) => void = () => undefined;
  show(
    client(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    ),
    'build_ready',
  );

  expect(screen.getByText('Loading delivery activity…')).toBeTruthy();
  await act(async () => resolve(activity([])));

  expect(
    screen.getByText(
      'No delivery activity yet. A builder will start when one is available.',
    ),
  ).toBeTruthy();
  expect(screen.queryByText('Loading delivery activity…')).toBeNull();
});

test('says failed checks plainly', async () => {
  show(
    client(async () => activity([plan, failed])),
    'building',
  );

  const trail = await screen.findByRole('region', {
    name: 'Delivery activity',
  });
  expect(
    within(trail).getByRole('heading', { name: 'Checks failed.' }),
  ).toBeTruthy();
  expect(
    within(trail).getByText(
      'The builder will correct them before the pull request opens.',
    ),
  ).toBeTruthy();
});

test('asks for plan approval with a way to review the plan', async () => {
  show(
    client(async () =>
      activity([plan], { current: { kind: 'plan_approval', runId: 'run-1' } }),
    ),
    'waiting',
  );

  expect(await screen.findByText('Plan approval needed.')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Review plan' }));
  expect(window.location.hash).toBe('#/conversations/run-1');
  window.location.hash = '';
});

test('replaces the trail when it cannot be read, and retries in place', async () => {
  let fail = true;
  show(
    client(async () => {
      if (fail) throw new Error('offline');
      return activity([plan]);
    }),
  );

  expect(
    await screen.findByText('Delivery activity couldn’t be loaded.'),
  ).toBeTruthy();
  expect(
    screen.getByText('Try again to see the latest delivery activity.'),
  ).toBeTruthy();
  expect(screen.queryByText('Plan recorded')).toBeNull();
  const retry = screen.getByRole('button', { name: 'Try again' });

  await userEvent.click(retry);
  expect(document.activeElement).toBe(retry);

  fail = false;
  await userEvent.click(retry);
  expect(await screen.findByText('Plan recorded')).toBeTruthy();
  expect(
    screen.queryByText('Delivery activity couldn’t be loaded.'),
  ).toBeNull();
});

test('adds earlier activity above without moving focus, until all is shown', async () => {
  const older: DeliveryEvent[] = Array.from({ length: 50 }, (_, index) => ({
    ...failed,
    id: String(index + 10),
  }));
  const deliveryClient = client(async (_itemId, before) =>
    before === undefined
      ? activity([pullRequest], { earlierCursor: '60' })
      : before === '60'
        ? activity(older, { earlierCursor: '10' })
        : activity([plan]),
  );
  show(deliveryClient);

  const more = await screen.findByRole('button', {
    name: 'Show earlier activity',
  });
  more.focus();
  await userEvent.click(more);

  await waitFor(() =>
    expect(
      screen.getAllByRole('heading', { name: 'Checks failed.' }),
    ).toHaveLength(50),
  );
  expect(document.activeElement).toBe(more);
  const trail = screen.getByRole('region', { name: 'Delivery activity' });
  const headings = within(trail).getAllByRole('heading', { level: 4 });
  expect(headings.at(0)?.textContent).toBe('Checks failed.');
  expect(headings.at(-1)?.textContent).toBe('Pull request opened');

  await userEvent.click(more);
  await waitFor(() =>
    expect(
      within(trail).getAllByRole('heading', { level: 4 }).at(0)?.textContent,
    ).toBe('Plan recorded'),
  );
  expect(
    screen.queryByRole('button', { name: 'Show earlier activity' }),
  ).toBeNull();
  expect(deliveryClient.reads).toEqual([undefined, '60', '10']);
});

test('appends new activity without moving focus', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let events: DeliveryEvent[] = [plan];
  show(
    client(async () => activity(events)),
    'building',
    1_000,
  );
  const planLink = await screen.findByRole('link', { name: 'Plan recorded' });
  planLink.focus();

  events = [plan, passed];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });

  expect(await screen.findByText('Checks passed')).toBeTruthy();
  expect(document.activeElement).toBe(planLink);
  const trail = screen.getByRole('region', { name: 'Delivery activity' });
  expect(
    within(trail)
      .getAllByRole('heading', { level: 4 })
      .map((heading) => heading.textContent),
  ).toEqual(['Plan recorded', 'Checks passed']);
});

test('remembers the followed link so Back returns focus to it', async () => {
  show(
    client(async () =>
      activity([plan, pullRequest], {
        latestPullRequest: pullRequest as Extract<
          DeliveryEvent,
          { kind: 'pull_request' }
        >,
      }),
    ),
  );
  const trail = await screen.findByRole('region', {
    name: 'Delivery activity',
  });
  const pullLink = within(trail).getByRole('link', { name: /^#482/ });
  pullLink.addEventListener('click', (event) => event.preventDefault());

  await userEvent.click(pullLink);

  expect(window.history.state).toMatchObject({
    cerebraDeliveryFocus: { itemId: 'item-1', linkId: 'delivery-link-4' },
  });
  cleanup();

  render(
    <DeliveryActivity
      client={client(async () => activity([plan, pullRequest]))}
      itemId="item-1"
      state="reviewing"
    />,
  );
  const restored = await screen.findByRole('link', { name: /^#482/ });
  await waitFor(() => expect(document.activeElement).toBe(restored));
});
