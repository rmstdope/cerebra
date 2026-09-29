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
    ...record(3, { kind: 'tool_call', name: 'Read' }),
  });
  client.push({
    type: 'event',
    ...record(2, { kind: 'message', text: 'Looking into it.' }),
  });

  expect(screen.getAllByText('Looking into it.')).toHaveLength(1);
  expect(screen.getByRole('status').textContent).toBe('Working');
  expect(screen.getByText('Still working…')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Activity' })).toBeTruthy();
  expect(screen.getByText('Used Read')).toBeTruthy();
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
  expect(alert.textContent).toContain(
    'Cerebra couldn’t load this conversation.',
  );
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
