import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';
import { cleanup } from '@testing-library/react';

import { ConversationPage } from './conversation-page';
import type {
  Conversation,
  ConversationClient,
  RecordedEvent,
  RunEvent,
  RunUpdate,
} from './runs';

afterEach(cleanup);

const startedAt = '2026-10-01T09:30:00.000Z';

function conversation(
  events: readonly RunEvent[] = [],
  run: Partial<Conversation['run']> = {},
): Conversation {
  return {
    events: events.map((event, index) => record(index + 1, event)),
    run: {
      agentId: 'agent-astra',
      agentName: 'Astra',
      agentRole: 'assistant',
      endedAt: null,
      failure: null,
      id: 'run-1',
      item: null,
      projectId: 'project-1',
      startedAt,
      state: 'starting',
      ...run,
    },
  };
}

function record(position: number, event: RunEvent): RecordedEvent {
  return { createdAt: startedAt, event, position };
}

interface FakeClient extends ConversationClient {
  readonly sent: string[];
  readonly answers: { questionId: string; answers: Record<string, string> }[];
  readonly planAnswers: { planId: number; verdict: string; text: string }[];
  readonly stopped: string[];
  readonly subscriptions: { after: number }[];
  push(update: RunUpdate): void;
}

function fakeClient(
  initial: Conversation,
  overrides: Partial<ConversationClient> = {},
): FakeClient {
  const listeners: ((update: RunUpdate) => void)[] = [];
  const client: FakeClient = {
    answer: async (_runId, questionId, answers) => {
      client.answers.push({ answers: { ...answers }, questionId });
    },
    answers: [],
    answerPlan: async (_runId, planId, verdict, text) => {
      client.planAnswers.push({ planId, text, verdict });
    },
    planAnswers: [],
    push: (update) => {
      act(() => {
        for (const listener of listeners) listener(update);
      });
    },
    read: async () => initial,
    send: async (_runId, text) => {
      client.sent.push(text);
    },
    sent: [],
    stop: async (runId) => {
      client.stopped.push(runId);
    },
    stopped: [],
    subscribe: (_runId, after, listener) => {
      client.subscriptions.push({ after });
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    subscriptions: [],
    ...overrides,
  };
  return client;
}

function renderPage(
  client: ConversationClient,
  extra: Partial<Parameters<typeof ConversationPage>[0]> = {},
) {
  return render(
    <ConversationPage
      client={client}
      now={() => new Date(startedAt)}
      onBack={() => undefined}
      onTryAgain={async () => undefined}
      runId="run-1"
      {...extra}
    />,
  );
}

const question: RunEvent = {
  kind: 'question',
  questionId: 'q-1',
  questions: [
    {
      header: 'Format',
      multiSelect: false,
      options: [
        { description: '', label: 'CSV' },
        { description: '', label: 'PDF' },
      ],
      question: 'Which export format comes first?',
    },
  ],
};

test('a new conversation invites the first message with the composer focused', async () => {
  renderPage(fakeClient(conversation()));

  expect(
    await screen.findByRole('heading', { name: 'Start the conversation' }),
  ).toBeTruthy();
  expect(screen.getByText('Send Astra a message to begin.')).toBeTruthy();
  expect(screen.getByRole('heading', { level: 1, name: 'Astra' })).toBeTruthy();
  expect(screen.getByText('Assistant')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('Ready');
  expect(document.activeElement).toBe(
    screen.getByRole('textbox', { name: 'Message Astra' }),
  );
  expect(screen.getByText('No work item attached')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Activity' })).toBeNull();
});

test('Enter sends the message and Shift+Enter starts a new line', async () => {
  const client = fakeClient(conversation());
  renderPage(client);
  const composer = await screen.findByRole('textbox', {
    name: 'Message Astra',
  });

  await userEvent.type(composer, 'First line{Shift>}{Enter}{/Shift}second');
  expect(client.sent).toEqual([]);
  await userEvent.keyboard('{Enter}');

  expect(client.sent).toEqual(['First line\nsecond']);
  expect((composer as HTMLTextAreaElement).value).toBe('');
  const thread = screen.getByTestId('thread');
  expect(thread.textContent).toContain('First line');
  expect(
    screen.queryByRole('heading', { name: 'Start the conversation' }),
  ).toBeNull();

  client.push({
    type: 'event',
    ...record(1, { kind: 'user_message', text: 'First line\nsecond' }),
  });
  expect(within(thread).getAllByText(/First line/)).toHaveLength(1);
});

test('live events are written into the thread and the newest reply shows it is still working', async () => {
  const client = fakeClient(
    conversation([{ kind: 'user_message', text: 'Hello' }], {
      state: 'active',
    }),
  );
  renderPage(client);
  await screen.findByText('Hello');
  expect(client.subscriptions).toEqual([{ after: 1 }]);

  client.push({
    type: 'event',
    ...record(2, { kind: 'message', text: 'Looking into it.' }),
  });
  client.push({
    type: 'event',
    ...record(3, call('t1', 'Read', {})),
  });
  client.push({
    type: 'event',
    ...record(2, { kind: 'message', text: 'Looking into it.' }),
  });

  expect(screen.getAllByText('Looking into it.')).toHaveLength(1);
  expect(screen.getByRole('status').textContent).toBe('Working');
  expect(screen.getByText('Still working…')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Activity' })).toBeTruthy();
  expect(screen.getByRole('listitem').textContent).toBe('Used Read');
  expect(screen.getByRole('button', { name: /Used Read/ })).toBeTruthy();
  expect(
    screen.getByText('You can send a message while Astra is working.'),
  ).toBeTruthy();
});

test('a question is a focused form; choosing an option answers it', async () => {
  const client = fakeClient(
    conversation([{ kind: 'user_message', text: 'Add exports' }], {
      state: 'active',
    }),
  );
  renderPage(client);
  await screen.findByText('Add exports');

  client.push({ type: 'event', ...record(2, question) });
  client.push({ state: 'awaiting_input', type: 'state', failure: null });

  const form = screen.getByRole('form', {
    name: 'Which export format comes first?',
  });
  await waitFor(() => expect(document.activeElement).toBe(form));
  expect(screen.getByRole('status').textContent).toBe(
    'Waiting for your answer',
  );
  expect(screen.getByLabelText('Or write your own answer')).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Message Astra' })).toBeTruthy();

  await userEvent.click(within(form).getByRole('button', { name: 'PDF' }));
  expect(client.answers).toEqual([
    {
      answers: { 'Which export format comes first?': 'PDF' },
      questionId: 'q-1',
    },
  ]);

  client.push({
    type: 'event',
    ...record(3, {
      answers: { 'Which export format comes first?': 'PDF' },
      kind: 'answer',
      questionId: 'q-1',
    }),
  });
  client.push({ state: 'active', type: 'state', failure: null });
  expect(screen.queryByRole('form')).toBeNull();
  expect(screen.getByText('Which export format comes first?')).toBeTruthy();
  expect(screen.getByText('PDF')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('Working');
});

test('a question can be answered in the navigator’s own words', async () => {
  const client = fakeClient(
    conversation([question], { state: 'awaiting_input' }),
  );
  renderPage(client);

  await userEvent.type(
    await screen.findByLabelText('Or write your own answer'),
    'Both, CSV first',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));

  expect(client.answers).toEqual([
    {
      answers: { 'Which export format comes first?': 'Both, CSV first' },
      questionId: 'q-1',
    },
  ]);
});

test('the panel names held work', async () => {
  renderPage(
    fakeClient(
      conversation([], {
        item: { id: 'item-1', title: 'Make reports easier to share' },
      }),
    ),
  );

  expect(await screen.findByText('Make reports easier to share')).toBeTruthy();
  expect(screen.getByText('Today at', { exact: false })).toBeTruthy();
});

test('Stop conversation asks first; Keep working changes nothing and returns focus', async () => {
  const client = fakeClient(conversation([], { state: 'active' }));
  renderPage(client);
  const stop = await screen.findByRole('button', { name: 'Stop conversation' });

  await userEvent.click(stop);
  const dialog = screen.getByRole('dialog', { name: 'Stop Astra?' });
  expect(document.activeElement).toBe(
    within(dialog).getByRole('button', { name: 'Keep working' }),
  );
  await userEvent.tab();
  await userEvent.tab();
  expect(dialog.contains(document.activeElement)).toBe(true);

  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Keep working' }),
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(client.stopped).toEqual([]);
  expect(document.activeElement).toBe(stop);

  await userEvent.click(stop);
  await userEvent.click(screen.getByRole('button', { name: 'Stop Astra' }));
  expect(client.stopped).toEqual(['run-1']);
  expect(document.activeElement).toBe(stop);
});

test('a finished conversation stays readable and replaces the message box', async () => {
  const backs: string[] = [];
  const client = fakeClient(
    conversation([{ kind: 'user_message', text: 'Hello' }], {
      state: 'active',
    }),
  );
  renderPage(client, { onBack: () => backs.push('back') });
  await screen.findByText('Hello');

  client.push({ failure: null, state: 'finished', type: 'state' });

  expect(screen.getByRole('status').textContent).toBe('Finished');
  expect(
    screen.getByRole('heading', { name: 'Conversation finished' }),
  ).toBeTruthy();
  expect(
    screen.getByText(
      'Astra has finished this conversation. Its messages and activity stay here for you to review.',
    ),
  ).toBeTruthy();
  expect(screen.getByText('Hello')).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'Message Astra' })).toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Stop conversation' }),
  ).toBeNull();

  const thread = screen.getByTestId('thread');
  await userEvent.click(
    within(thread).getByRole('button', { name: 'Back to fleet' }),
  );
  expect(backs).toEqual(['back']);
});

test('a failed conversation keeps its thread and offers to try again', async () => {
  const retried: string[] = [];
  renderPage(
    fakeClient(
      conversation([{ kind: 'user_message', text: 'Hello' }], {
        failure: 'The runner disconnected.',
        state: 'failed',
      }),
    ),
    { onTryAgain: async (agentId) => void retried.push(agentId) },
  );

  expect(
    await screen.findByRole('heading', { name: 'Astra stopped unexpectedly' }),
  ).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe('Failed');
  expect(
    screen.getByText(
      'The conversation ended before Astra could finish. Your messages and its activity are still here.',
    ),
  ).toBeTruthy();
  expect(screen.getByText('Hello')).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'Message Astra' })).toBeNull();

  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(retried).toEqual(['agent-astra']);
});

test('a conversation that cannot be read says so and can be retried', async () => {
  let reads = 0;
  renderPage(
    fakeClient(conversation(), {
      read: async () => {
        reads += 1;
        if (reads === 1) throw new Error('down');
        return conversation();
      },
    }),
  );

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Couldn’t load this conversation.');
  expect(alert.textContent).toContain(
    'Your messages are safe. Try again in a moment.',
  );
  expect(
    screen.queryByRole('heading', { name: 'Start the conversation' }),
  ).toBeNull();
  await userEvent.click(
    within(alert).getByRole('button', { name: 'Try again' }),
  );
  expect(
    await screen.findByRole('heading', { name: 'Start the conversation' }),
  ).toBeTruthy();
});

test('a message that cannot be sent is kept in the box with an error', async () => {
  renderPage(
    fakeClient(conversation(), {
      send: async () => {
        throw new Error('down');
      },
    }),
  );
  const composer = await screen.findByRole('textbox', {
    name: 'Message Astra',
  });

  await userEvent.type(composer, 'Hello{Enter}');

  expect((await screen.findByRole('alert')).textContent).toBe(
    'Cerebra couldn’t send that message. Try again.',
  );
  expect((composer as HTMLTextAreaElement).value).toBe('Hello');
  expect(screen.getByTestId('thread').textContent).not.toContain('Hello');
});

test('new activity does not move someone reading earlier messages', async () => {
  const client = fakeClient(
    conversation([{ kind: 'user_message', text: 'Hello' }], {
      state: 'active',
    }),
  );
  renderPage(client);
  await screen.findByText('Hello');
  const thread = screen.getByTestId('thread');
  Object.defineProperty(thread, 'scrollHeight', {
    configurable: true,
    value: 1000,
  });
  Object.defineProperty(thread, 'clientHeight', {
    configurable: true,
    value: 200,
  });

  thread.scrollTop = 100;
  thread.dispatchEvent(new Event('scroll'));
  client.push({
    type: 'event',
    ...record(2, { kind: 'message', text: 'More' }),
  });
  expect(thread.scrollTop).toBe(100);

  thread.scrollTop = 790;
  thread.dispatchEvent(new Event('scroll'));
  client.push({
    type: 'event',
    ...record(3, { kind: 'message', text: 'Even more' }),
  });
  expect(thread.scrollTop).toBe(1000);
});

function call(
  toolCallId: string,
  name: string,
  input: unknown,
  parentToolCallId?: string,
): RunEvent {
  return {
    input,
    kind: 'tool_call',
    name,
    toolCallId,
    ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
  };
}

function result(
  toolCallId: string,
  content: string,
  isError = false,
  parentToolCallId?: string,
): RunEvent {
  return {
    content,
    isError,
    kind: 'tool_result',
    toolCallId,
    ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
  };
}

test('each step is a line between messages; a running one says so and a finished one opens its output', async () => {
  const client = fakeClient(
    conversation(
      [
        { kind: 'message', text: 'I’ll look at the board code first.' },
        call('t1', 'Read', { file_path: 'src/board.ts' }),
        result('t1', 'export const board = 1;'),
        call('t2', 'Bash', { command: 'pnpm test' }),
      ],
      { state: 'active' },
    ),
  );
  renderPage(client);

  const read = await screen.findByRole('button', {
    name: /Read src\/board\.ts/,
  });
  expect(read.getAttribute('aria-expanded')).toBe('false');
  expect(within(read).getByText('Succeeded')).toBeTruthy();
  expect(screen.queryByText('export const board = 1;')).toBeNull();

  read.focus();
  await userEvent.keyboard('{Enter}');
  expect(read.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText('export const board = 1;')).toBeTruthy();
  await userEvent.keyboard(' ');
  expect(screen.queryByText('export const board = 1;')).toBeNull();

  const running = screen.getByRole('button', { name: /Ran pnpm test/ });
  expect(within(running).getByText('Running…')).toBeTruthy();

  client.push({
    type: 'event',
    ...record(5, result('t2', 'Exit code 1\nFAIL src/a.test.ts', true)),
  });
  expect(within(running).getByText('Failed — exit 1')).toBeTruthy();
  client.push({
    type: 'event',
    ...record(6, { kind: 'message', text: 'A test failed; fixing it.' }),
  });
  expect(screen.getByText('A test failed; fixing it.')).toBeTruthy();
});

test('a step with empty output says there was none, and a failure without an exit code reads Failed', async () => {
  renderPage(
    fakeClient(
      conversation(
        [
          call('t1', 'Glob', { pattern: '*.md' }),
          result('t1', ''),
          call('t2', 'Edit', { file_path: 'a.ts' }),
          result('t2', 'String to replace not found', true),
        ],
        { state: 'active' },
      ),
    ),
  );

  await userEvent.click(
    await screen.findByRole('button', { name: /Found files matching/ }),
  );
  expect(screen.getByText('No output.')).toBeTruthy();
  expect(
    within(screen.getByRole('button', { name: /Edited a\.ts/ })).getByText(
      'Failed',
    ),
  ).toBeTruthy();
});

test('a change to a file is open by default and shows its removed and added lines', async () => {
  renderPage(
    fakeClient(
      conversation(
        [
          call('t1', 'Edit', {
            file_path: 'src/board.ts',
            new_string: 'const x = 2\nlog(x)',
            old_string: 'const x = 1',
          }),
          result('t1', 'The file was updated.'),
        ],
        { state: 'active' },
      ),
    ),
  );

  const line = await screen.findByRole('button', {
    name: /Edited src\/board\.ts/,
  });
  expect(line.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByText('+2 −1')).toBeTruthy();
  expect(
    screen
      .getByText('const x = 1')
      .closest('[data-diff]')
      ?.getAttribute('data-diff'),
  ).toBe('removed');
  expect(
    screen
      .getByText('log(x)')
      .closest('[data-diff]')
      ?.getAttribute('data-diff'),
  ).toBe('added');
  expect(screen.getByText('Removed:', { exact: false })).toBeTruthy();

  await userEvent.click(line);
  expect(screen.queryByText('log(x)')).toBeNull();
});

test('output longer than 20 lines shows its first 20 and can show all of it', async () => {
  const output = Array.from({ length: 1234 }, (_, i) => `line ${i + 1}`).join(
    '\n',
  );
  renderPage(
    fakeClient(
      conversation(
        [call('t1', 'Bash', { command: 'pnpm test' }), result('t1', output)],
        { state: 'active' },
      ),
    ),
  );

  await userEvent.click(
    await screen.findByRole('button', { name: /Ran pnpm test/ }),
  );
  expect(screen.getByText(/line 20$/, { exact: false })).toBeTruthy();
  const pre = screen.getByTestId('step-output');
  expect(pre.textContent?.split('\n')).toHaveLength(20);

  const all = screen.getByRole('button', {
    name: `Show all ${(1234).toLocaleString()} lines`,
  });
  all.focus();
  await userEvent.keyboard(' ');
  expect(
    screen.getByTestId('step-output').textContent?.split('\n'),
  ).toHaveLength(1234);
  expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
});

test('a helper is nested under the step that started it, with its own messages and steps', async () => {
  const client = fakeClient(
    conversation(
      [
        { kind: 'message', text: 'I’ll ask a helper to review the change.' },
        {
          description: 'Review the diff',
          kind: 'subagent_start',
          subagentType: 'reviewer',
          toolCallId: 'h1',
        },
        { kind: 'message', parentToolCallId: 'h1', text: 'Reading the diff…' },
        call('t1', 'Read', { file_path: 'src/board.ts' }, 'h1'),
        result('t1', 'x', false, 'h1'),
      ],
      { state: 'active' },
    ),
  );
  renderPage(client);

  const helper = await screen.findByRole('button', {
    name: /Started helper: “Review the diff”/,
  });
  expect(within(helper).getByText('Working')).toBeTruthy();
  expect(helper.getAttribute('aria-expanded')).toBe('true');
  const nest = screen.getByRole('group', { name: 'Helper “Review the diff”' });
  expect(within(nest).getByText('Reading the diff…')).toBeTruthy();
  expect(within(nest).getByText('Helper', { selector: 'span' })).toBeTruthy();
  expect(
    within(nest).getByRole('button', { name: /Read src\/board\.ts/ }),
  ).toBeTruthy();

  client.push({
    type: 'event',
    ...record(6, call('t2', 'Grep', { pattern: 'null' }, 'h1')),
  });
  client.push({
    type: 'event',
    ...record(7, { isError: false, kind: 'subagent_end', toolCallId: 'h1' }),
  });

  const finished = screen.getByRole('button', {
    name: /Helper “Review the diff” finished · 2 steps/,
  });
  expect(finished.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText('Reading the diff…')).toBeNull();
  finished.focus();
  await userEvent.keyboard('{Enter}');
  expect(screen.getByText('Reading the diff…')).toBeTruthy();
});

test('a helper that failed, or was left unfinished by an ended run, stopped unexpectedly', async () => {
  renderPage(
    fakeClient(
      conversation(
        [
          {
            description: 'Run e2e',
            kind: 'subagent_start',
            subagentType: 'task',
            toolCallId: 'h1',
          },
          { isError: true, kind: 'subagent_end', toolCallId: 'h1' },
          {
            description: 'Check docs',
            kind: 'subagent_start',
            subagentType: 'task',
            toolCallId: 'h2',
          },
          call('t1', 'Bash', { command: 'sleep 99' }),
          {
            description: 'One more',
            kind: 'subagent_start',
            subagentType: 'task',
            toolCallId: 'h3',
          },
          { isError: false, kind: 'subagent_end', toolCallId: 'h3' },
        ],
        { state: 'failed' },
      ),
    ),
  );

  expect(
    await screen.findByRole('button', {
      name: /Helper “Run e2e” stopped unexpectedly/,
    }),
  ).toBeTruthy();
  expect(
    screen.getByRole('button', {
      name: /Helper “Check docs” stopped unexpectedly/,
    }),
  ).toBeTruthy();
  expect(
    screen.getByRole('button', {
      name: /Helper “One more” finished · 0 steps/,
    }),
  ).toBeTruthy();
  expect(
    within(screen.getByRole('button', { name: /Ran sleep 99/ })).getByText(
      'Failed',
    ),
  ).toBeTruthy();
  expect(screen.queryByText('Running…')).toBeNull();
});

test('a helper that took one step says 1 step', async () => {
  renderPage(
    fakeClient(
      conversation([
        {
          description: 'Look',
          kind: 'subagent_start',
          subagentType: 'task',
          toolCallId: 'h1',
        },
        call('t1', 'Read', {}, 'h1'),
        { isError: false, kind: 'subagent_end', toolCallId: 'h1' },
      ]),
    ),
  );
  expect(
    await screen.findByRole('button', {
      name: /Helper “Look” finished · 1 step$/,
    }),
  ).toBeTruthy();
});

test('whatever an assistant writes is shown as text and never becomes part of the page', async () => {
  const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  renderPage(
    fakeClient(
      conversation(
        [
          { kind: 'message', text: hostile },
          call('t1', 'Bash', { command: hostile }),
          result('t1', hostile),
          call('t2', 'Write', { content: hostile, file_path: 'x.html' }),
          {
            description: hostile,
            kind: 'subagent_start',
            subagentType: 'task',
            toolCallId: 'h1',
          },
          { kind: 'message', parentToolCallId: 'h1', text: hostile },
        ],
        { state: 'active' },
      ),
    ),
  );

  await userEvent.click(
    await screen.findByRole('button', { name: /Ran <img/ }),
  );
  expect(screen.getAllByText(hostile, { exact: false }).length).toBeGreaterThan(
    3,
  );
  expect(document.querySelector('img')).toBeNull();
  expect(document.querySelector('script')).toBeNull();
});

test('a conversation with an open question focuses the question form when it opens', async () => {
  renderPage(
    fakeClient(
      conversation([{ kind: 'user_message', text: 'Add exports' }, question], {
        state: 'awaiting_input',
      }),
    ),
  );

  const form = await screen.findByRole('form', {
    name: 'Which export format comes first?',
  });
  await waitFor(() => expect(document.activeElement).toBe(form));
});

const outcomeText = [
  'Confirm the outcome and where it goes next',
  '## Problem',
  'Accountants re-type invoices into their ledger each month.',
  '## Who benefits',
  'Finance staff.',
  '## Outcome',
  'Any filtered invoice list downloads as a CSV.',
  '## Out of scope',
  'Credit notes.',
  '## How we will know',
  'A month of invoices imports with no edits.',
].join('\n');

const outcomeQuestion: RunEvent = {
  kind: 'question',
  questionId: 'q-o',
  questions: [
    {
      header: 'Outcome',
      multiSelect: false,
      options: [
        {
          description: 'agree what people will see first',
          label: 'Design next (Recommended)',
        },
        {
          description: 'nothing new to see; go straight to building',
          label: 'Build next',
        },
      ],
      question: outcomeText,
    },
  ],
};

const groomer: Partial<Conversation['run']> = {
  agentId: 'agent-gale',
  agentName: 'Gale',
  agentRole: 'groomer',
  item: { id: 'item-1', title: 'Export invoices as CSV' },
};

function outcomeMove(id: string, isError: boolean): RunEvent[] {
  return [
    {
      input: { record: { kind: 'outcome', markdown: 'x' }, to: 'design_ready' },
      kind: 'tool_call',
      name: 'mcp__cerebra__transition',
      toolCallId: id,
    },
    {
      content: isError ? '{"error":"refused"}' : '{"state":"design_ready"}',
      isError,
      kind: 'tool_result',
      toolCallId: id,
    },
  ];
}

test('the groomer asks for the outcome as one focused form; a route answers it', async () => {
  const client = fakeClient(
    conversation([outcomeQuestion], { ...groomer, state: 'awaiting_input' }),
  );
  renderPage(client);

  const form = await screen.findByRole('form', {
    name: 'Confirm the outcome and where it goes next',
  });
  await waitFor(() => expect(document.activeElement).toBe(form));
  expect(screen.getByText('Groomer · Export invoices as CSV')).toBeTruthy();
  expect(
    within(form).getByText('Gale needs one answer before it can continue.'),
  ).toBeTruthy();
  for (const heading of [
    'Problem',
    'Who benefits',
    'Outcome',
    'Out of scope',
    'How we will know',
  ]) {
    expect(within(form).getByRole('heading', { name: heading })).toBeTruthy();
  }
  expect(
    within(form).getByText(
      'Accountants re-type invoices into their ledger each month.',
    ),
  ).toBeTruthy();
  expect(
    within(form).getByRole('button', {
      name: 'Design next — agree what people will see first (recommended by Gale)',
    }),
  ).toBeTruthy();
  expect(within(form).getByLabelText('Or write your own answer')).toBeTruthy();

  await userEvent.click(
    within(form).getByRole('button', {
      name: 'Build next — nothing new to see; go straight to building',
    }),
  );
  expect(client.answers).toEqual([
    { answers: { [outcomeText]: 'Build next' }, questionId: 'q-o' },
  ]);
});

test('an answered outcome stays readable in the thread', async () => {
  renderPage(
    fakeClient(
      conversation(
        [
          outcomeQuestion,
          {
            answers: { [outcomeText]: 'Design next (Recommended)' },
            kind: 'answer',
            questionId: 'q-o',
          },
        ],
        { ...groomer, state: 'active' },
      ),
    ),
  );

  const block = await screen.findByRole('region', {
    name: 'Confirm the outcome and where it goes next',
  });
  expect(
    within(block).getByRole('heading', { name: 'Out of scope' }),
  ).toBeTruthy();
  expect(within(block).queryByRole('button')).toBeNull();
  expect(screen.getByText('Design next')).toBeTruthy();
  expect(screen.queryByRole('form')).toBeNull();
});

test('a refused outcome says nothing moved and Try again asks the groomer to retry', async () => {
  const client = fakeClient(
    conversation([...outcomeMove('t1', true), ...outcomeMove('t2', true)], {
      ...groomer,
      state: 'active',
    }),
  );
  renderPage(client);

  expect(
    await screen.findAllByText('Gale couldn’t record the outcome.'),
  ).toHaveLength(2);
  expect(
    screen.getAllByText('Nothing was moved. Your answer is kept; try again.'),
  ).toHaveLength(2);
  const retry = screen.getAllByRole('button', { name: 'Try again' });
  expect(retry).toHaveLength(1);

  await userEvent.click(retry[0]!);
  expect(client.sent).toEqual(['Try again.']);

  client.push({ type: 'event', ...record(5, outcomeMove('t3', false)[0]!) });
  client.push({ type: 'event', ...record(6, outcomeMove('t3', false)[1]!) });
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
});

test('an item the groomer filed is a link that opens it on its board', async () => {
  const opened: [string, string][] = [];
  renderPage(
    fakeClient(
      conversation(
        [
          {
            input: { description: 'd', title: 'Bulk export for credit notes' },
            kind: 'tool_call',
            name: 'mcp__cerebra__create_item',
            toolCallId: 'c1',
          },
          {
            content: '{"id":"item-7","priority":null,"state":"new"}',
            isError: false,
            kind: 'tool_result',
            toolCallId: 'c1',
          },
        ],
        { ...groomer, state: 'active' },
      ),
    ),
    { onOpenItem: (projectId, itemId) => opened.push([projectId, itemId]) },
  );

  await userEvent.click(
    await screen.findByRole('button', { name: 'Bulk export for credit notes' }),
  );
  expect(opened).toEqual([['project-1', 'item-7']]);
  expect(
    screen.getAllByText('Filed “Bulk export for credit notes”').length,
  ).toBeGreaterThan(0);
});

const planMarkdown = [
  '## Context',
  'An “Export” entry in the board menu.',
  '## Files to change, and what to reuse',
  '- The export menu and its button',
  '## Increments',
  '1. Export what is shown, as CSV',
  '## The test plan',
  'Unit tests.',
  '## User-facing decisions',
  '### Agreed with the navigator',
  'See the design record.',
  '### Decided by me',
  '- The file is named after the project and today’s date.',
  '## Out of scope',
  'Nothing.',
].join('\n');

const builder = {
  agentName: 'Rogue',
  agentRole: 'builder',
  item: { id: 'item-1', title: 'Add export button' },
  state: 'awaiting_input' as const,
};

const planEvent: RunEvent = {
  kind: 'plan_approval',
  markdown: planMarkdown,
  planId: 11,
};

test('a waiting plan shows its sections and is approved from the card', async () => {
  const client = fakeClient(conversation([planEvent], builder));
  renderPage(client);

  const card = await screen.findByRole('region', {
    name: 'Plan for your approval Add export button',
  });
  expect(document.activeElement).toBe(card);
  expect(screen.getByRole('status').textContent).toBe(
    'Waiting for your answer',
  );
  const headings = within(card)
    .getAllByRole('heading', { level: 3 })
    .map((heading) => heading.textContent);
  expect(headings).toEqual([
    'Files to change',
    'What’s new',
    'Increments',
    'Decisions I made that the design left open',
  ]);
  expect(
    within(card).getByText(
      '- The file is named after the project and today’s date.',
    ),
  ).toBeTruthy();
  expect(within(card).queryByText('See the design record.')).toBeNull();
  expect(within(card).queryByText('Unit tests.')).toBeNull();

  await userEvent.click(
    within(card).getByRole('button', { name: 'Approve plan' }),
  );
  expect(client.planAnswers).toEqual([
    { planId: 11, text: '', verdict: 'approved' },
  ]);
  expect(document.activeElement).toBe(card);

  client.push({
    type: 'event',
    ...record(2, {
      kind: 'plan_answer',
      planId: 11,
      text: '',
      verdict: 'approved',
    }),
  });
  expect(within(card).getByText('Plan · approved')).toBeTruthy();
  expect(within(card).queryByRole('button')).toBeNull();
  expect(screen.getByText('Plan approved.')).toBeTruthy();
  expect(document.activeElement).toBe(card);
});

test('asking for changes needs words, and Cancel returns to the button', async () => {
  const client = fakeClient(conversation([planEvent], builder));
  renderPage(client);
  const card = await screen.findByRole('region', {
    name: 'Plan for your approval Add export button',
  });

  const ask = within(card).getByRole('button', { name: 'Ask for changes…' });
  await userEvent.click(ask);
  const box = within(card).getByRole('textbox', {
    name: 'What should change?',
  });
  expect(document.activeElement).toBe(box);

  await userEvent.click(within(card).getByRole('button', { name: 'Cancel' }));
  expect(within(card).queryByRole('textbox')).toBeNull();
  expect(document.activeElement).toBe(ask);

  await userEvent.click(ask);
  await userEvent.click(within(card).getByRole('button', { name: 'Send' }));
  expect(within(card).getByRole('alert').textContent).toBe(
    'Say what should change so the builder can revise the plan.',
  );
  expect(client.planAnswers).toEqual([]);

  await userEvent.type(
    within(card).getByRole('textbox', { name: 'What should change?' }),
    'Also handle the empty board.',
  );
  await userEvent.click(within(card).getByRole('button', { name: 'Send' }));
  expect(client.planAnswers).toEqual([
    { planId: 11, text: 'Also handle the empty board.', verdict: 'changes' },
  ]);
  expect(document.activeElement).toBe(card);

  client.push({
    type: 'event',
    ...record(2, {
      kind: 'plan_answer',
      planId: 11,
      text: 'Also handle the empty board.',
      verdict: 'changes',
    }),
  });
  client.push({
    type: 'event',
    ...record(3, { kind: 'plan_approval', markdown: planMarkdown, planId: 12 }),
  });
  expect(within(card).getByText('Plan · you asked for changes')).toBeTruthy();
  expect(within(card).getByText('“Also handle the empty board.”')).toBeTruthy();
  expect(
    screen.getByRole('region', {
      name: 'Plan · revised · for your approval Add export button',
    }),
  ).toBeTruthy();
});

test('an answer that fails to send says so and keeps the card', async () => {
  const client = fakeClient(conversation([planEvent], builder), {
    answerPlan: async () => {
      throw new Error('offline');
    },
  });
  renderPage(client);
  const card = await screen.findByRole('region', {
    name: 'Plan for your approval Add export button',
  });

  await userEvent.click(
    within(card).getByRole('button', { name: 'Approve plan' }),
  );
  expect(within(card).getByRole('alert').textContent).toBe(
    'Your answer wasn’t sent. Try again.',
  );
  expect(
    within(card).getByRole('button', { name: 'Approve plan' }),
  ).toBeTruthy();
});

test('a plan the builder stopped before answering is no longer waiting', async () => {
  renderPage(
    fakeClient(conversation([planEvent], { ...builder, state: 'failed' })),
  );

  const card = await screen.findByRole('region', {
    name: 'Plan · no longer waiting Add export button',
  });
  expect(
    within(card).getByText(
      'The builder stopped before you answered. The next builder writes a new plan.',
    ),
  ).toBeTruthy();
  expect(within(card).queryByRole('button')).toBeNull();
});

test('a plan whose builder stopped waiting is no longer waiting, while the run goes on', async () => {
  renderPage(
    fakeClient(
      conversation([planEvent, { kind: 'plan_withdrawn', planId: 11 }], {
        ...builder,
        state: 'active',
      }),
    ),
  );

  const card = await screen.findByRole('region', {
    name: 'Plan · no longer waiting Add export button',
  });
  expect(within(card).queryByRole('button')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('Working');
});
