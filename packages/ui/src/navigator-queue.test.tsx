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

import { BoardRequestError } from './board';
import { NavigatorQueue } from './navigator-queue';
import type {
  QueueClient,
  QueueDecision,
  QueueEntry,
  QueuePage,
} from './queue';

afterEach(cleanup);

function entry(overrides: Partial<QueueEntry>): QueueEntry {
  return {
    askedBy: null,
    availableRoutes: ['grooming_ready', 'design_ready', 'build_ready'],
    blocked: false,
    checkpoint: null,
    description: '',
    id: 'item',
    kind: 'new',
    priority: null,
    projectId: 'project-1',
    projectName: 'acme/mobile',
    run: null,
    since: '2026-09-29T00:00:00.000Z',
    title: 'Untitled',
    waitingReason: null,
    ...overrides,
  };
}

const attention = entry({
  id: 'attention',
  kind: 'attention',
  projectId: 'project-2',
  projectName: 'northstar/admin',
  title: 'Sign-in keeps failing',
  waitingReason: 'The build fails the same way every round.',
});
const question = entry({
  askedBy: 'Storm',
  description: 'Storm has found two supported approaches.',
  id: 'question',
  kind: 'question',
  title: 'Which release should we support?',
  waitingReason: 'Should the first release include the previous app too?',
});
const newWork = entry({
  id: 'new',
  kind: 'new',
  title: 'Make reports easier to share',
});
const review = entry({
  id: 'review',
  kind: 'review',
  title: 'Check the payment reminder change',
});

function page(
  entries: readonly QueueEntry[],
  total = entries.length,
): QueuePage {
  return { entries, notices: [], total };
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

function createClient(overrides: Partial<QueueClient> = {}): QueueClient {
  return {
    answer: async () => undefined,
    decide: async () => undefined,
    list: async () => page([attention, question, newWork, review]),
    ...overrides,
  };
}

function renderQueue(
  client: QueueClient,
  {
    onCountChange = () => undefined,
    onOpenBackups = () => undefined,
    now = () => new Date('2026-09-29T00:12:30.000Z'),
    onOpenConversation = () => undefined,
    onViewWork = () => undefined,
    pollIntervalMs = 60_000,
    storage = memoryStorage(),
  }: {
    now?: () => Date;
    onOpenConversation?: (runId: string) => void;
    onCountChange?: (count: number) => void;
    onOpenBackups?: () => void;
    onViewWork?: (projectId: string, itemId: string, tab: string) => void;
    pollIntervalMs?: number;
    storage?: Pick<Storage, 'getItem' | 'setItem'>;
  } = {},
) {
  return render(
    <NavigatorQueue
      client={client}
      now={now}
      onCountChange={onCountChange}
      onOpenBackups={onOpenBackups}
      onOpenConversation={onOpenConversation}
      onViewWork={onViewWork}
      pollIntervalMs={pollIntervalMs}
      storage={storage}
    />,
  );
}

function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

async function openRequest(title: RegExp | string) {
  const row = await screen.findByRole('button', {
    name: typeof title === 'string' ? new RegExp(title) : title,
  });
  await userEvent.click(row);
  return row;
}

test('lists every request under its project with the words of its type', async () => {
  renderQueue(createClient());

  expect(
    screen.getByRole('heading', { level: 2, name: 'What needs you' }),
  ).toBeTruthy();
  expect(
    screen.getByText(
      'Questions and decisions from every project, in one place.',
    ),
  ).toBeTruthy();
  const list = await screen.findByRole('region', { name: 'Navigator queue' });
  expect(within(list).getByText('Waiting for you')).toBeTruthy();
  expect(within(list).getByText('4 requests')).toBeTruthy();

  const rows = within(list)
    .getAllByRole('button')
    .map((button) => button.textContent);
  expect(rows).toEqual([
    '▾northstar/admin',
    'Needs attentionSign-in keeps failingChoose what happens next',
    '▾acme/mobile',
    'QuestionWhich release should we support?Storm needs your answer',
    'NewMake reports easier to shareNeeds a priority and next step',
    'ReviewCheck the payment reminder changeReady for your review',
  ]);
});

test('shows a loading placeholder, then the reassuring empty state', async () => {
  let respond: (value: QueuePage) => void = () => undefined;
  renderQueue(
    createClient({
      list: () =>
        new Promise<QueuePage>((resolve) => {
          respond = resolve;
        }),
    }),
  );

  expect(screen.getAllByText('Loading…').length).toBeGreaterThan(0);
  await act(async () => respond(page([])));

  expect(await screen.findByText('You’re all caught up.')).toBeTruthy();
  expect(
    screen.getByText('There are no questions or decisions waiting for you.'),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Refresh queue' })).toBeTruthy();
});

test('keeps the shown requests when a refresh fails, and retries', async () => {
  const user = userEvent.setup();
  let fail = false;
  renderQueue(
    createClient({
      list: async () => {
        if (fail) throw new Error('offline');
        return page([question]);
      },
    }),
    { pollIntervalMs: 20 },
  );

  await screen.findByRole('button', { name: /Which release/ });
  fail = true;
  expect(
    await screen.findByText(
      'Cerebra couldn’t refresh what needs you. The requests already shown may be out of date.',
    ),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: /Which release/ })).toBeTruthy();
  expect(screen.queryByText('You’re all caught up.')).toBeNull();

  fail = false;
  await user.click(screen.getByRole('button', { name: 'Try again' }));
  await waitFor(() =>
    expect(
      screen.queryByText(/Cerebra couldn’t refresh what needs you/),
    ).toBeNull(),
  );
});

test('never shows a failed first read as an empty queue', async () => {
  renderQueue(
    createClient({
      list: async () => {
        throw new Error('offline');
      },
    }),
  );

  expect(
    await screen.findByText(/Cerebra couldn’t refresh what needs you/),
  ).toBeTruthy();
  expect(screen.queryByText('You’re all caught up.')).toBeNull();
});

test('answers a question, removes it and moves focus to the next request', async () => {
  const user = userEvent.setup();
  const sent = deferred();
  const answers: unknown[] = [];
  renderQueue(
    createClient({
      answer: async (itemId, answer) => {
        answers.push({ answer, itemId });
        await sent.promise;
      },
    }),
  );

  await openRequest('Which release');
  const detail = screen.getByRole('complementary', {
    name: 'Selected request',
  });
  expect(
    within(detail).getByText('Question from Storm · acme/mobile'),
  ).toBeTruthy();
  expect(
    within(detail).getByRole('heading', {
      name: 'Which release should we support?',
    }),
  ).toBeTruthy();
  expect(within(detail).getByText('Storm asks')).toBeTruthy();
  expect(
    within(detail).getByText(
      '“Should the first release include the previous app too?”',
    ),
  ).toBeTruthy();
  const answer = within(detail).getByLabelText('Your answer');
  expect(answer.getAttribute('placeholder')).toBe('Write your answer…');
  await user.type(answer, 'The current app only.');
  await user.click(within(detail).getByRole('button', { name: 'Send answer' }));

  const sending = within(detail).getByRole('button', { name: 'Sending…' });
  expect((sending as HTMLButtonElement).disabled).toBe(true);
  await act(async () => sent.resolve());

  expect(answers).toEqual([
    { answer: 'The current app only.', itemId: 'question' },
  ]);
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: /Which release/ })).toBeNull(),
  );
  expect(screen.getByText('3 requests')).toBeTruthy();
  expect(screen.queryByLabelText('Your answer')).toBeNull();
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /Make reports easier/ }),
    ),
  );
});

test('keeps a failed answer in place with its error', async () => {
  const user = userEvent.setup();
  renderQueue(
    createClient({
      answer: async () => {
        throw new Error('offline');
      },
    }),
  );

  await openRequest('Which release');
  await user.type(screen.getByLabelText('Your answer'), 'Current only.');
  await user.click(screen.getByRole('button', { name: 'Send answer' }));

  expect(
    await screen.findByText('Cerebra couldn’t save your answer. Try again.'),
  ).toBeTruthy();
  expect(
    (screen.getByLabelText('Your answer') as HTMLTextAreaElement).value,
  ).toBe('Current only.');
});

test('opens the conversation or the work on its project board', async () => {
  const user = userEvent.setup();
  const opened: unknown[] = [];
  renderQueue(createClient(), {
    onViewWork: (projectId, itemId, tab) =>
      opened.push({ itemId, projectId, tab }),
  });

  await openRequest('Which release');
  await user.click(screen.getByRole('button', { name: 'Open conversation' }));
  await user.click(screen.getByRole('button', { name: 'View work' }));

  expect(opened).toEqual([
    { itemId: 'question', projectId: 'project-1', tab: 'discussion' },
    { itemId: 'question', projectId: 'project-1', tab: 'overview' },
  ]);
});

test('reopens a review without a reason', async () => {
  const user = userEvent.setup();
  const decisions: QueueDecision[] = [];
  renderQueue(
    createClient({
      decide: async (_itemId, decision) => {
        decisions.push(decision);
      },
    }),
  );

  await openRequest('Check the payment');
  const detail = screen.getByRole('complementary', {
    name: 'Selected request',
  });
  expect(within(detail).getByText('Review · acme/mobile')).toBeTruthy();
  const save = within(detail).getByRole('button', { name: 'Save decision' });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  await user.click(
    within(detail).getByRole('radio', { name: /Reopen this work/ }),
  );
  expect(
    within(detail).getByText('Send it back to be worked on again.'),
  ).toBeTruthy();
  expect(within(detail).queryByLabelText('Reason')).toBeNull();
  await user.click(save);

  expect(decisions).toEqual([{ direction: 'reopen' }]);
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: /Check the payment/ }),
    ).toBeNull(),
  );
  // The last request in its project hands focus to the one before it.
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /Make reports easier/ }),
    ),
  );
});

test('redirects new work with a priority, a next step and a reason', async () => {
  const user = userEvent.setup();
  const decisions: QueueDecision[] = [];
  renderQueue(
    createClient({
      decide: async (_itemId, decision) => {
        decisions.push(decision);
      },
      list: async () =>
        page([
          { ...newWork, availableRoutes: ['grooming_ready', 'build_ready'] },
        ]),
    }),
  );

  await openRequest('Make reports');
  const detail = screen.getByRole('complementary', {
    name: 'Selected request',
  });
  expect(within(detail).getByText('New · acme/mobile')).toBeTruthy();
  expect(
    within(detail).queryByRole('radio', { name: /Reopen this work/ }),
  ).toBeNull();
  await user.click(
    within(detail).getByRole('radio', { name: /Choose another next step/ }),
  );
  expect(
    within(detail).getByText('Override the current direction with a reason.'),
  ).toBeTruthy();
  expect(
    within(detail).queryByRole('radio', { name: /Send to design/ }),
  ).toBeNull();
  await user.click(within(detail).getByRole('radio', { name: 'P1' }));
  await user.click(
    within(detail).getByRole('radio', { name: /Send to build/ }),
  );
  const save = within(detail).getByRole('button', { name: 'Save decision' });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  await user.type(within(detail).getByLabelText('Reason'), 'It is small.');
  await user.click(save);

  expect(decisions).toEqual([
    {
      direction: 'redirect',
      priority: 'P1',
      reason: 'It is small.',
      to: 'build_ready',
    },
  ]);
  expect(await screen.findByText('You’re all caught up.')).toBeTruthy();
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'What needs you' }),
    ),
  );
});

test('keeps a failed decision in place and shows Saving… while it sends', async () => {
  const user = userEvent.setup();
  const sent = deferred();
  renderQueue(createClient({ decide: () => sent.promise }));

  await openRequest('Sign-in keeps failing');
  const detail = screen.getByRole('complementary', {
    name: 'Selected request',
  });
  expect(
    within(detail).getByText('Needs attention · northstar/admin'),
  ).toBeTruthy();
  expect(
    within(detail).getByText('The build fails the same way every round.'),
  ).toBeTruthy();
  await user.click(
    within(detail).getByRole('radio', { name: /Choose another next step/ }),
  );
  await user.click(
    within(detail).getByRole('radio', { name: /Send to design/ }),
  );
  await user.type(within(detail).getByLabelText('Reason'), 'Needs a design.');
  await user.click(
    within(detail).getByRole('button', { name: 'Save decision' }),
  );

  expect(
    (
      within(detail).getByRole('button', {
        name: 'Saving…',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await act(async () => sent.reject(new BoardRequestError('down', null)));

  expect(
    await within(detail).findByText(
      'Cerebra couldn’t save your decision. Try again.',
    ),
  ).toBeTruthy();
  expect(
    (within(detail).getByLabelText('Reason') as HTMLTextAreaElement).value,
  ).toBe('Needs a design.');
  expect(
    (
      within(detail).getByRole('radio', {
        name: /Choose another next step/,
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
});

test('returns focus to the decision when a confirmed cancellation fails', async () => {
  const user = userEvent.setup();
  renderQueue(
    createClient({
      decide: async () => {
        throw new Error('offline');
      },
    }),
  );

  await openRequest('Check the payment');
  await user.click(screen.getByRole('radio', { name: /Cancel this work/ }));
  await user.type(screen.getByLabelText('Reason'), 'No longer needed.');
  const save = screen.getByRole('button', { name: 'Save decision' });
  await user.click(save);
  await user.click(screen.getByRole('button', { name: 'Cancel work' }));

  expect(
    await screen.findByText('Cerebra couldn’t save your decision. Try again.'),
  ).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(save));
});

test('confirms a cancellation with managed focus', async () => {
  const user = userEvent.setup();
  const decisions: QueueDecision[] = [];
  renderQueue(
    createClient({
      decide: async (_itemId, decision) => {
        decisions.push(decision);
      },
    }),
  );

  await openRequest('Check the payment');
  await user.click(screen.getByRole('radio', { name: /Cancel this work/ }));
  expect(screen.getByText('End it with a reason.')).toBeTruthy();
  await user.type(screen.getByLabelText('Reason'), 'No longer needed.');
  const save = screen.getByRole('button', { name: 'Save decision' });
  await user.click(save);

  const dialog = screen.getByRole('dialog', { name: 'Cancel this work?' });
  expect(
    within(dialog).getByText('This ends the work and records your reason.'),
  ).toBeTruthy();
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(dialog).getByRole('heading', { name: 'Cancel this work?' }),
    ),
  );

  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(save));
  expect(decisions).toEqual([]);

  await user.click(save);
  await user.click(screen.getByRole('button', { name: 'Keep work' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(save));

  await user.click(save);
  await user.click(screen.getByRole('button', { name: 'Cancel work' }));
  expect(decisions).toEqual([
    { direction: 'cancel', reason: 'No longer needed.' },
  ]);
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: /Check the payment/ }),
    ).toBeNull(),
  );
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('offers a way back from the full-screen request on a narrow window', async () => {
  const user = userEvent.setup();
  renderQueue(createClient());

  const row = await openRequest('Which release');
  await user.click(
    screen.getByRole('button', { name: 'Back to what needs you' }),
  );

  expect(screen.queryByLabelText('Your answer')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(row));
});

test('announces arrivals without moving the rows until refreshed', async () => {
  const user = userEvent.setup();
  const counts: number[] = [];
  const arrival = entry({ id: 'arrival', title: 'Arrived later' });
  let listed: readonly QueueEntry[] = [question];
  renderQueue(
    createClient({
      list: async () => page(listed),
    }),
    { onCountChange: (count) => counts.push(count), pollIntervalMs: 20 },
  );

  await screen.findByRole('button', { name: /Which release/ });
  listed = [question, arrival];
  expect(await screen.findByText(/1 new request —/)).toBeTruthy();
  expect(screen.getByText('2 requests')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Arrived later/ })).toBeNull();
  expect(counts.at(-1)).toBe(2);

  listed = [question, arrival, { ...arrival, id: 'arrival-2' }];
  expect(await screen.findByText(/2 new requests —/)).toBeTruthy();

  const notice = screen.getByRole('status');
  await user.click(
    within(notice).getByRole('button', { name: 'Refresh queue' }),
  );
  expect(
    (await screen.findAllByRole('button', { name: /Arrived later/ })).length,
  ).toBe(2);
  expect(screen.queryByText(/new request/)).toBeNull();
});

test('remembers grouping, selection and count after a reload but not a half-written answer', async () => {
  const user = userEvent.setup();
  const storage = memoryStorage();
  const client = createClient();
  const first = renderQueue(client, { storage });

  const heading = await screen.findByRole('button', {
    name: 'northstar/admin',
  });
  expect(heading.getAttribute('aria-expanded')).toBe('true');
  await user.click(heading);
  expect(heading.getAttribute('aria-expanded')).toBe('false');
  expect(
    screen.queryByRole('button', { name: /Sign-in keeps failing/ }),
  ).toBeNull();
  await openRequest('Which release');
  await user.type(screen.getByLabelText('Your answer'), 'Half written');
  first.unmount();

  const counts: number[] = [];
  let respond: (value: QueuePage) => void = () => undefined;
  renderQueue(
    createClient({
      list: () =>
        new Promise<QueuePage>((resolve) => {
          respond = resolve;
        }),
    }),
    { onCountChange: (count) => counts.push(count), storage },
  );
  expect(counts[0]).toBe(4);
  await act(async () => respond(page([attention, question, newWork, review])));

  expect(
    (
      await screen.findByRole('button', { name: 'northstar/admin' })
    ).getAttribute('aria-expanded'),
  ).toBe('false');
  expect(
    screen.queryByRole('button', { name: /Sign-in keeps failing/ }),
  ).toBeNull();
  expect(
    (screen.getByLabelText('Your answer') as HTMLTextAreaElement).value,
  ).toBe('');
  expect(
    screen.getByRole('heading', { name: 'Which release should we support?' }),
  ).toBeTruthy();
});

test('shows an inline Loading… while a deliberate refresh keeps the rows', async () => {
  const user = userEvent.setup();
  let respond: ((value: QueuePage) => void) | null = null;
  const list = vi.fn(async () => page([question]));
  renderQueue(createClient({ list }));

  await openRequest('Which release');
  list.mockImplementationOnce(
    () =>
      new Promise<QueuePage>((resolve) => {
        respond = resolve;
      }),
  );
  await user.click(screen.getByRole('button', { name: 'Refresh queue' }));

  expect(screen.getByRole('button', { name: /Which release/ })).toBeTruthy();
  expect(
    screen.getByRole('heading', { name: 'Which release should we support?' }),
  ).toBeTruthy();
  expect(screen.getAllByText('Loading…').length).toBeGreaterThan(0);
  await act(async () => respond?.(page([question])));
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
});

const assistantQuestion = entry({
  askedBy: 'Astra',
  availableRoutes: [],
  id: 'run:run-7:q-1',
  kind: 'question',
  run: { id: 'run-7' },
  since: '2026-09-29T00:00:00.000Z',
  title: 'Which database should the demo use?',
  waitingReason: 'Which database should the demo use?',
});

test('an assistant’s question says who asks, how long it has waited, and Answer opens the conversation', async () => {
  const opened: string[] = [];
  renderQueue(
    createClient({ list: async () => page([assistantQuestion, newWork]) }),
    { onOpenConversation: (runId) => opened.push(runId) },
  );

  const row = (
    await screen.findByText('Astra asks: Which database should the demo use?')
  ).closest('[data-run]');
  if (row === null) throw new Error('no row');
  expect(within(row).getByText('Question')).toBeTruthy();
  expect(within(row).getByText('Waiting 12 min')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Astra asks/ })).toBeNull();

  const answer = within(row).getByRole('button', { name: 'Answer' });
  answer.focus();
  await userEvent.keyboard('{Enter}');
  expect(opened).toEqual(['run-7']);
  expect(screen.queryByRole('heading', { name: /Which database/ })).toBeNull();
});

test('the waiting time reads in minutes, hours and days', async () => {
  const at = (minutes: number) =>
    new Date(Date.parse('2026-09-29T00:00:00.000Z') + minutes * 60_000);
  for (const [minutes, words] of [
    [0.5, 'Waiting less than a minute'],
    [59, 'Waiting 59 min'],
    [150, 'Waiting 2 h'],
    [60 * 24 * 3 + 5, 'Waiting 3 d'],
  ] as const) {
    renderQueue(createClient({ list: async () => page([assistantQuestion]) }), {
      now: () => at(minutes),
    });
    expect(await screen.findByText(words)).toBeTruthy();
    cleanup();
  }
});

test('a remembered selection never opens an assistant’s question', async () => {
  const storage = memoryStorage();
  storage.setItem(
    'cerebra.queue',
    JSON.stringify({ collapsed: [], count: 1, selected: assistantQuestion.id }),
  );
  renderQueue(createClient({ list: async () => page([assistantQuestion]) }), {
    storage,
  });
  await screen.findByText('Astra asks: Which database should the demo use?');
  expect(screen.queryByLabelText('Your answer')).toBeNull();
});

test('an open request from the attention center reads the queue again and selects that work', async () => {
  const list = vi.fn(async () => page([attention, question, newWork, review]));
  const client = createClient({ list });
  const storage = memoryStorage();
  storage.setItem(
    'cerebra.queue',
    JSON.stringify({ collapsed: ['project-1'], count: 4, selected: null }),
  );
  const props = {
    client,
    now: () => new Date('2026-09-29T00:12:30.000Z'),
    onViewWork: () => undefined,
    pollIntervalMs: 60_000,
    storage,
  };
  const view = render(<NavigatorQueue {...props} openRequest={null} />);
  await screen.findByRole('button', { name: /Sign-in keeps failing/ });
  expect(list).toHaveBeenCalledTimes(1);

  view.rerender(<NavigatorQueue {...props} openRequest={{ id: 'review' }} />);

  const row = await screen.findByRole('button', {
    name: /Check the payment reminder change/,
  });
  await waitFor(() => expect(document.activeElement).toBe(row));
  expect(row.getAttribute('aria-current')).toBe('true');
  expect(list).toHaveBeenCalledTimes(2);
});

test('shows a failed backup above the projects and counts it until it clears', async () => {
  const counts: number[] = [];
  const opened: string[] = [];
  const failed: QueuePage = {
    entries: [],
    notices: [
      {
        at: '2026-09-29T00:02:00.000Z',
        cause: 'the backup folder is full',
        kind: 'backup_failed',
      },
    ],
    total: 0,
  };
  const pages = [failed, page([])];
  renderQueue(
    createClient({
      list: async () => (pages.length > 1 ? pages.shift()! : pages[0]!),
    }),
    {
      onCountChange: (count) => counts.push(count),
      onOpenBackups: () => opened.push('backups'),
    },
  );

  const notice = await screen.findByRole('region', { name: 'Cerebra' });
  expect(within(notice).getByText('Backup failed')).toBeTruthy();
  const when = new Date('2026-09-29T00:02:00.000Z');
  const clock = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  expect(
    within(notice).getByText(
      new RegExp(`at ${clock} · the backup folder is full$`),
    ),
  ).toBeTruthy();
  expect(screen.queryByText('You’re all caught up.')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Navigator queue' })).toBeNull();
  await waitFor(() => expect(counts.at(-1)).toBe(1));

  await userEvent.click(
    within(notice).getByRole('button', { name: 'Open Backups' }),
  );
  expect(opened).toEqual(['backups']);

  await userEvent.click(screen.getByRole('button', { name: 'Refresh queue' }));

  expect(await screen.findByText('You’re all caught up.')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Cerebra' })).toBeNull();
  expect(counts.at(-1)).toBe(0);
});

test('a blocked merge says why with its project, and Open shows the item', async () => {
  const user = userEvent.setup();
  const opened: unknown[] = [];
  const blocked = entry({
    blocked: true,
    id: 'blocked',
    kind: 'attention',
    projectId: 'project-2',
    projectName: 'northstar/admin',
    title: 'Add export button',
    waitingReason: "Can't merge: a required check failed",
  });
  renderQueue(createClient({ list: async () => page([blocked, newWork]) }), {
    onViewWork: (projectId, itemId, tab) =>
      opened.push({ itemId, projectId, tab }),
  });

  const row = (await screen.findByText('Add export button')).closest(
    '[data-blocked]',
  );
  if (row === null) throw new Error('no row');
  expect(
    within(row as HTMLElement).getByText(
      "Can't merge: a required check failed · northstar/admin",
    ),
  ).toBeTruthy();
  await user.click(
    within(row as HTMLElement).getByRole('button', { name: 'Open' }),
  );

  expect(opened).toEqual([
    { itemId: 'blocked', projectId: 'project-2', tab: 'overview' },
  ]);
});

test('checkpoints say what waits with its project, and Open goes where it is answered', async () => {
  const user = userEvent.setup();
  const conversations: string[] = [];
  const items: unknown[] = [];
  const plan = entry({
    askedBy: 'Rogue',
    availableRoutes: [],
    checkpoint: 'plan',
    id: 'plan:run-9:11',
    kind: 'review',
    projectName: 'acme/mobile',
    run: { id: 'run-9' },
    title: 'Add export button',
    waitingReason: 'Plan waiting for your approval',
  });
  const codeReview = entry({
    checkpoint: 'code_review',
    id: 'item-4',
    kind: 'attention',
    projectId: 'project-2',
    projectName: 'northstar/admin',
    title: 'Sign-in keeps failing',
    waitingReason: 'Waiting for your review on GitHub',
  });
  renderQueue(
    createClient({ list: async () => page([plan, codeReview, newWork]) }),
    {
      onOpenConversation: (runId) => conversations.push(runId),
      onViewWork: (projectId, itemId, tab) =>
        items.push({ itemId, projectId, tab }),
    },
  );

  const planRow = (await screen.findByText('Add export button')).closest(
    '[data-checkpoint]',
  ) as HTMLElement;
  expect(
    within(planRow).getByText('Plan waiting for your approval · acme/mobile'),
  ).toBeTruthy();
  await user.click(within(planRow).getByRole('button', { name: 'Open' }));
  expect(conversations).toEqual(['run-9']);

  const reviewRow = screen
    .getByText('Sign-in keeps failing')
    .closest('[data-checkpoint]') as HTMLElement;
  expect(
    within(reviewRow).getByText(
      'Waiting for your review on GitHub · northstar/admin',
    ),
  ).toBeTruthy();
  await user.click(within(reviewRow).getByRole('button', { name: 'Open' }));
  expect(items).toEqual([
    { itemId: 'item-4', projectId: 'project-2', tab: 'overview' },
  ]);
});
