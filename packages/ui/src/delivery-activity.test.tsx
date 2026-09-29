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

test('replaces a shown trail when a later read fails', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let fail = false;
  show(
    client(async () => {
      if (fail) throw new Error('offline');
      return activity([plan]);
    }),
    'building',
    1_000,
  );
  expect(await screen.findByText('Plan recorded')).toBeTruthy();

  fail = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });

  expect(
    await screen.findByText('Delivery activity couldn’t be loaded.'),
  ).toBeTruthy();
  expect(screen.queryByText('Plan recorded')).toBeNull();
});

test('names the reviewer generically when none is known', async () => {
  show(
    client(async () =>
      activity([plan], {
        current: { kind: 'waiting_for_review', reviewer: null },
      }),
    ),
  );

  expect(
    await screen.findByText(
      'The reviewer will review the pull request next. Nothing is needed from you.',
    ),
  ).toBeTruthy();
});

const revision = 'd4e5f6a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6';

function finding(
  severity: 'advisory' | 'blocking',
  index: number,
): { file: string; line: number; problem: string; severity: typeof severity } {
  return {
    file: `src/export-${index}.ts`,
    line: index,
    problem: `Problem ${index}`,
    severity,
  };
}

const changesRequested: DeliveryEvent = {
  agentName: 'Rogue',
  at: '2026-10-04T11:00:00.000Z',
  findings: [
    finding('advisory', 1),
    finding('blocking', 2),
    finding('advisory', 3),
    finding('blocking', 4),
    finding('advisory', 5),
    finding('advisory', 6),
    finding('advisory', 7),
  ],
  id: '5',
  kind: 'review',
  revision,
  runId: 'run-2',
  url: 'https://github.com/acme/website/pull/482#pullrequestreview-1',
  verdict: 'changes_requested',
};
const reworkStarted: DeliveryEvent = {
  agentName: 'Wolverine',
  at: '2026-10-04T11:05:00.000Z',
  id: '6',
  kind: 'rework_started',
  maxRounds: 3,
  round: 2,
  runId: 'run-3',
};
const approved: DeliveryEvent = {
  agentName: 'Rogue',
  at: '2026-10-04T11:30:00.000Z',
  findings: [],
  id: '7',
  kind: 'review',
  revision,
  runId: 'run-4',
  url: null,
  verdict: 'approved',
};
const checkFailed: Extract<DeliveryEvent, { kind: 'blocked' }> = {
  agentName: null,
  at: '2026-10-04T11:40:00.000Z',
  check: 'build',
  id: '8',
  kind: 'blocked',
  reason: 'check_failed',
  revision,
  reviewer: 'Rogue',
  runId: null,
};
const merged: DeliveryEvent = {
  agentName: null,
  at: '2026-10-04T11:50:00.000Z',
  base: 'main',
  id: '9',
  kind: 'merged',
  runId: null,
  sha: 'abc1234',
};

test('tells review and merge in the trail: findings, rework, approval, merge', async () => {
  show(
    client(async () =>
      activity([changesRequested, reworkStarted, approved, merged]),
    ),
    'done',
  );

  const trail = await screen.findByRole('region', {
    name: 'Delivery activity',
  });
  const headings = await within(trail).findAllByRole('heading', { level: 4 });
  expect(headings.map((heading) => heading.textContent)).toEqual([
    'Changes requested',
    'Rework started',
    'Approved',
    'Merged',
  ]);
  expect(
    within(trail).getByText("Rogue's review of revision d4e5f6a:"),
  ).toBeTruthy();
  expect(
    within(trail).getByText(
      'Wolverine is correcting the same pull request. Round 2 of 3.',
    ),
  ).toBeTruthy();
  expect(
    within(trail).getByText('Rogue approved revision d4e5f6a.'),
  ).toBeTruthy();
  expect(
    within(trail).getByText('Merged into main and the branch was deleted.'),
  ).toBeTruthy();
  const review = within(trail).getByRole('link', {
    name: 'Open the review on GitHub',
  });
  expect(review.getAttribute('href')).toBe(changesRequested.url);
  expect(review.getAttribute('target')).toBeNull();
  // Only the review that recorded a url links to one; the approval had no findings to list.
  expect(
    within(trail).getAllByRole('link', { name: 'Open the review on GitHub' }),
  ).toHaveLength(1);
  expect(within(trail).getAllByRole('list', { name: 'Findings' })).toHaveLength(
    1,
  );
});

test('lists five findings, blocking first, and shows the rest in place', async () => {
  const user = userEvent.setup();
  show(client(async () => activity([changesRequested])));

  const list = await screen.findByRole('list', { name: 'Findings' });
  const lines = () =>
    within(list)
      .getAllByRole('listitem')
      .map((line) => line.textContent);
  expect(lines()).toEqual([
    'Blockingsrc/export-2.ts:2 — Problem 2',
    'Blockingsrc/export-4.ts:4 — Problem 4',
    'Advisorysrc/export-1.ts:1 — Problem 1',
    'Advisorysrc/export-3.ts:3 — Problem 3',
    'Advisorysrc/export-5.ts:5 — Problem 5',
  ]);

  const scroll = vi.spyOn(HTMLElement.prototype, 'focus');
  await user.click(screen.getByRole('button', { name: 'Show all 7 findings' }));

  expect(lines()).toHaveLength(7);
  expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
  const sixth = within(list).getAllByRole('listitem')[5];
  expect(document.activeElement).toBe(sixth);
  expect(scroll).toHaveBeenCalledWith({ preventScroll: true });
  scroll.mockRestore();
});

test('lists an approval’s advisory findings under it', async () => {
  show(
    client(async () =>
      activity([
        { ...approved, findings: [finding('advisory', 1)] } as DeliveryEvent,
      ]),
    ),
  );

  const list = await screen.findByRole('list', { name: 'Findings' });
  expect(within(list).getByText('Advisory')).toBeTruthy();
});

test('says it merges on its own while the checks run', async () => {
  show(
    client(async () =>
      activity([approved], { current: { kind: 'waiting_for_checks' } }),
    ),
    'merging',
  );

  expect(await screen.findByText('Waiting for checks')).toBeTruthy();
  expect(
    screen.getByText(
      'It merges automatically once every required check passes.',
    ),
  ).toBeTruthy();
});

test.each([
  [
    { reason: 'check_failed', check: 'build', revision, reviewer: 'Rogue' },
    "Can't merge: a required check failed",
    '“build” failed on revision d4e5f6a. Rogue approved it, but nothing merges red.',
  ],
  [
    { reason: 'conflict', base: 'main' },
    "Can't merge: the branch conflicts with main",
    "The pull request can't be merged cleanly into main.",
  ],
  [
    { reason: 'changed_since_approval', revision, reviewer: 'Rogue' },
    "Can't merge: changed since approval",
    "New changes arrived after Rogue approved revision d4e5f6a. They haven't been reviewed.",
  ],
  [
    { reason: 'too_many_rounds', count: 3 },
    "Can't merge: too many rounds",
    'This has gone back to the builder 3 times without being approved.',
  ],
  [
    { reason: 'too_many_attempts', count: 2 },
    'Stopped: too many attempts',
    '2 builder runs ended without finishing this.',
  ],
] as const)(
  'a block shows a banner with its reason and a waiting trail entry (%o)',
  async (detail, heading, sentence) => {
    const event = {
      ...checkFailed,
      check: undefined,
      reviewer: undefined,
      revision: undefined,
      ...detail,
    } as DeliveryEvent & { kind: 'blocked' };
    render(
      <DeliveryActivity
        client={client(async () =>
          activity([approved, event], {
            blocked: { canReturnToDesign: true, event },
            latestPullRequest: pullRequest as Extract<
              DeliveryEvent,
              { kind: 'pull_request' }
            >,
          }),
        )}
        intervalMs={60_000}
        itemId="item-1"
        lead={<p>The description</p>}
        state="waiting"
      />,
    );

    const banner = await screen.findByRole('region', { name: heading });
    expect(within(banner).getByText(sentence)).toBeTruthy();
    expect(
      within(banner).getByRole('button', { name: 'Send back to the builder' }),
    ).toBeTruthy();
    expect(
      within(banner).getByRole('button', { name: 'Return to design…' }),
    ).toBeTruthy();
    expect(
      within(banner)
        .getByRole('link', { name: 'Open the pull request' })
        .getAttribute('href'),
    ).toBe('https://github.com/acme/website/pull/482');
    // The banner opens the Overview, above its lead and the trail.
    const lead = screen.getByText('The description');
    expect(
      banner.compareDocumentPosition(lead) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const trail = screen.getByRole('region', { name: 'Delivery activity' });
    const last = within(trail).getAllByRole('listitem').at(-1)!;
    expect(within(last).getByText(heading)).toBeTruthy();
    expect(within(last).getByText('Waiting for you.')).toBeTruthy();
  },
);

test('a block the navigator has answered no longer waits', async () => {
  show(
    client(async () => activity([checkFailed])),
    'build_ready',
  );

  expect(
    await screen.findByText(
      '“build” failed on revision d4e5f6a. Rogue approved it, but nothing merges red.',
    ),
  ).toBeTruthy();
  expect(screen.queryByText('Waiting for you.')).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Send back to the builder' }),
  ).toBeNull();
});

test('hides return to design when the project has no design stage', async () => {
  show(
    client(async () =>
      activity([checkFailed], {
        blocked: { canReturnToDesign: false, event: checkFailed },
      }),
    ),
    'waiting',
  );

  expect(
    await screen.findByRole('button', { name: 'Send back to the builder' }),
  ).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'Return to design…' }),
  ).toBeNull();
});

function answering(
  answer: Partial<Pick<DeliveryActivityClient, 'returnToDesign' | 'sendBack'>>,
) {
  let answered: DeliveryEvent | null = null;
  const blockedPage = activity([approved, checkFailed], {
    blocked: { canReturnToDesign: true, event: checkFailed },
  });
  const deliveryClient: DeliveryActivityClient = {
    read: async () =>
      answered === null
        ? blockedPage
        : activity([approved, checkFailed, answered]),
    returnToDesign: async (itemId, reason) => {
      await answer.returnToDesign?.(itemId, reason);
      answered = {
        agentName: null,
        at: '2026-10-04T12:00:00.000Z',
        id: '10',
        kind: 'returned_to_design',
        reason,
        runId: null,
      };
      return { id: itemId, state: 'design_ready' };
    },
    sendBack: async (itemId) => {
      await answer.sendBack?.(itemId);
      answered = {
        agentName: null,
        at: '2026-10-04T12:00:00.000Z',
        id: '10',
        kind: 'sent_back',
        runId: null,
      };
      return { id: itemId, state: 'build_ready' };
    },
  };
  const onAnswered = vi.fn();
  render(
    <DeliveryActivity
      client={deliveryClient}
      intervalMs={60_000}
      itemId="item-1"
      onAnswered={onAnswered}
      state="waiting"
    />,
  );
  return { onAnswered };
}

test('sending back acts at once: the banner goes and focus moves to the new entry', async () => {
  const user = userEvent.setup();
  const { onAnswered } = answering({});

  await user.click(
    await screen.findByRole('button', { name: 'Send back to the builder' }),
  );

  const entry = await screen.findByText('Sent back to the builder', {
    selector: 'h4',
  });
  await waitFor(() => expect(document.activeElement).toBe(entry.closest('li')));
  expect(
    screen.queryByRole('button', { name: 'Send back to the builder' }),
  ).toBeNull();
  expect(onAnswered).toHaveBeenCalledWith({
    id: 'item-1',
    state: 'build_ready',
  });
});

test('a send-back that fails keeps the banner and focus, and says so', async () => {
  const user = userEvent.setup();
  answering({
    sendBack: async () => {
      throw new Error('offline');
    },
  });

  const button = await screen.findByRole('button', {
    name: 'Send back to the builder',
  });
  await user.click(button);

  expect(
    await screen.findByText("That didn't go through. Try again."),
  ).toBeTruthy();
  expect(document.activeElement).toBe(button);
  expect(
    screen.queryByText('Sent back to the builder', { selector: 'h4' }),
  ).toBeNull();
});

test('return to design asks for a reason in a dialog, then closes the pull request', async () => {
  const user = userEvent.setup();
  const returned: string[] = [];
  answering({
    returnToDesign: async (_itemId, reason) => {
      returned.push(reason);
    },
  });

  const opener = await screen.findByRole('button', {
    name: 'Return to design…',
  });
  await user.click(opener);
  const dialog = screen.getByRole('dialog', { name: 'Return to design?' });
  expect(
    within(dialog).getByText(
      'The pull request will be closed with your reason, and the next build starts a new one.',
    ),
  ).toBeTruthy();
  const reason = within(dialog).getByLabelText('Why is it going back?');
  expect(document.activeElement).toBe(reason);

  await user.click(
    within(dialog).getByRole('button', { name: 'Return to design' }),
  );
  expect(
    within(dialog).getByText(
      'Give a reason so the designer and the next builder know what to change.',
    ),
  ).toBeTruthy();
  expect(document.activeElement).toBe(reason);
  expect(returned).toEqual([]);

  await user.type(reason, 'The export needs a CSV option');
  await user.click(
    within(dialog).getByRole('button', { name: 'Return to design' }),
  );

  const entry = await screen.findByText('Returned to design', {
    selector: 'h4',
  });
  expect(
    screen.getByText(
      '“The export needs a CSV option” The pull request was closed.',
    ),
  ).toBeTruthy();
  expect(returned).toEqual(['The export needs a CSV option']);
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(entry.closest('li')));
});

test('Esc or Cancel closes the dialog unsaved and returns focus to its button', async () => {
  const user = userEvent.setup();
  const returned: string[] = [];
  answering({
    returnToDesign: async (_itemId, reason) => {
      returned.push(reason);
    },
  });
  const opener = await screen.findByRole('button', {
    name: 'Return to design…',
  });

  await user.click(opener);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(opener));

  await user.click(opener);
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(opener));
  expect(returned).toEqual([]);
});

test('a return that fails keeps the dialog, the reason and says so above its buttons', async () => {
  const user = userEvent.setup();
  answering({
    returnToDesign: async () => {
      throw new Error('offline');
    },
  });

  await user.click(
    await screen.findByRole('button', { name: 'Return to design…' }),
  );
  const dialog = screen.getByRole('dialog', { name: 'Return to design?' });
  await user.type(
    within(dialog).getByLabelText('Why is it going back?'),
    'Wrong shape',
  );
  await user.click(
    within(dialog).getByRole('button', { name: 'Return to design' }),
  );

  expect(
    await within(dialog).findByText("That didn't go through. Try again."),
  ).toBeTruthy();
  expect(
    (
      within(dialog).getByLabelText(
        'Why is it going back?',
      ) as HTMLTextAreaElement
    ).value,
  ).toBe('Wrong shape');
  expect(
    screen.getByRole('button', { name: 'Send back to the builder' }),
  ).toBeTruthy();
});

test('the banner goes when a later read shows the item has moved on', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let moved = false;
  show(
    client(async () =>
      moved
        ? activity([checkFailed])
        : activity([checkFailed], {
            blocked: { canReturnToDesign: true, event: checkFailed },
          }),
    ),
    'waiting',
    1_000,
  );
  expect(
    await screen.findByRole('button', { name: 'Send back to the builder' }),
  ).toBeTruthy();

  moved = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });

  expect(
    screen.queryByRole('button', { name: 'Send back to the builder' }),
  ).toBeNull();
});

test('an item back in design shows no empty delivery story', async () => {
  show(
    client(async () => activity([])),
    'design_ready',
  );

  await waitFor(() =>
    expect(screen.queryByText('Loading delivery activity…')).toBeNull(),
  );
  expect(
    screen.queryByRole('region', { name: 'Delivery activity' }),
  ).toBeNull();
});
