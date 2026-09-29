import {
  parseDownMessage,
  parseUpMessage,
  runnerProtocol,
  RunnerProtocolError,
  type AgentEvent,
  maxFetchPaths,
  type DownMessage,
  type UpMessage,
} from '@cerebra/shared';
import { describe, expect, test } from 'vitest';

const start: DownMessage = {
  type: 'start',
  backend: 'claude',
  model: 'opus',
  effort: 'high',
  instructions: 'You are the assistant.',
  interactive: true,
  firstMessage: 'Hello.',
  resumeSessionId: null,
  mcpServers: {
    cerebra: {
      type: 'http',
      url: 'http://cerebra:4317/mcp',
      headers: { Authorization: 'Bearer run-token' },
    },
  },
  skills: ['release'],
};

const usage = {
  costUsd: 0.25,
  models: {
    'claude-opus': {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 40,
    },
  },
};

const events: AgentEvent[] = [
  { kind: 'message', text: 'Hi.' },
  { kind: 'thinking', text: 'Hmm.', parentToolCallId: 'task-1' },
  { kind: 'tool_call', toolCallId: 't1', name: 'Bash', input: { a: 1 } },
  { kind: 'tool_result', toolCallId: 't1', content: 'ok', isError: false },
  {
    kind: 'subagent_start',
    toolCallId: 'task-1',
    subagentType: 'general-purpose',
    description: 'Look around',
  },
  { kind: 'subagent_end', toolCallId: 'task-1', isError: false },
  {
    kind: 'question',
    questionId: 'q1',
    questions: [
      {
        question: 'Which one?',
        header: 'Choice',
        multiSelect: false,
        options: [
          { label: 'A', description: 'First' },
          { label: 'B', description: 'Second' },
        ],
      },
    ],
  },
  { kind: 'answer', questionId: 'q1', answers: { 'Which one?': 'A' } },
  { kind: 'user_message', text: 'Also this.' },
  { kind: 'status', status: 'awaiting_input' },
  { kind: 'error', message: 'rate_limit' },
  { kind: 'result', end: 'turn', sessionId: 's1', usage },
  { kind: 'result', end: 'failed', usage, error: 'boom' },
];

describe('down messages', () => {
  const messages: DownMessage[] = [
    start,
    { type: 'user_message', text: 'More context.' },
    { type: 'answer', questionId: 'q1', answers: { 'Which one?': 'B' } },
    { type: 'interrupt' },
    { type: 'stop' },
    { type: 'fetch_files', requestId: 'r1', paths: ['mockups/a.html'] },
  ];

  test.each(messages)('parses $type', (message) => {
    expect(parseDownMessage(JSON.stringify(message))).toEqual(message);
  });

  test('refuses a backend the runner does not run', () => {
    expect(() =>
      parseDownMessage(JSON.stringify({ ...start, backend: 'copilot' })),
    ).toThrow(new RunnerProtocolError('Unsupported backend: copilot'));
  });

  test('refuses an unknown message type', () => {
    expect(() =>
      parseDownMessage(JSON.stringify({ type: 'push_files' })),
    ).toThrow(new RunnerProtocolError('Unknown message type: push_files'));
  });

  test('refuses fetch_files asking for no paths or too many', () => {
    const ask = (paths: string[]) =>
      parseDownMessage(
        JSON.stringify({ type: 'fetch_files', requestId: 'r1', paths }),
      );
    expect(() => ask([])).toThrow(
      new RunnerProtocolError(
        `fetch_files.paths must name between 1 and ${maxFetchPaths} files`,
      ),
    );
    expect(() =>
      ask(Array.from({ length: maxFetchPaths + 1 }, (_, i) => `f${i}`)),
    ).toThrow(
      new RunnerProtocolError(
        `fetch_files.paths must name between 1 and ${maxFetchPaths} files`,
      ),
    );
  });

  test('refuses a message missing a field', () => {
    expect(() =>
      parseDownMessage(JSON.stringify({ type: 'user_message' })),
    ).toThrow(new RunnerProtocolError('user_message.text must be a string'));
  });

  test('refuses text that is not JSON', () => {
    expect(() => parseDownMessage('{')).toThrow(RunnerProtocolError);
  });

  test('refuses answers that are not text', () => {
    expect(() =>
      parseDownMessage(
        JSON.stringify({ type: 'answer', questionId: 'q', answers: { a: 1 } }),
      ),
    ).toThrow(new RunnerProtocolError('answer.answers must map text to text'));
  });
});

describe('up messages', () => {
  test.each(events)('parses a $kind event', (event) => {
    const message = { type: 'event', seq: 3, event };
    expect(parseUpMessage(JSON.stringify(message))).toEqual(message);
  });

  test('refuses an unknown event kind', () => {
    expect(() =>
      parseUpMessage(
        JSON.stringify({ type: 'event', seq: 1, event: { kind: 'usage' } }),
      ),
    ).toThrow(new RunnerProtocolError('Unknown event kind: usage'));
  });

  test('refuses a sequence number that is not a positive integer', () => {
    expect(() =>
      parseUpMessage(
        JSON.stringify({
          type: 'event',
          seq: 0,
          event: { kind: 'message', text: '' },
        }),
      ),
    ).toThrow(new RunnerProtocolError('event.seq must be a positive integer'));
  });

  test('refuses an unknown message type', () => {
    expect(() => parseUpMessage(JSON.stringify({ type: 'blobs' }))).toThrow(
      new RunnerProtocolError('Unknown message type: blobs'),
    );
  });

  const answers: UpMessage[] = [
    {
      type: 'files',
      requestId: 'r1',
      files: [
        {
          path: 'mockups/a.html',
          contentType: 'text/html',
          content: Buffer.from('<p>a</p>').toString('base64'),
        },
      ],
    },
    {
      type: 'files',
      requestId: 'r1',
      error: 'The path ../etc/passwd is outside the checkout.',
    },
  ];

  test.each(answers)('parses files answering $requestId', (message) => {
    expect(parseUpMessage(JSON.stringify(message))).toEqual(message);
  });

  test('refuses files that carry neither files nor an error', () => {
    expect(() =>
      parseUpMessage(JSON.stringify({ type: 'files', requestId: 'r1' })),
    ).toThrow(new RunnerProtocolError('files.files must be a list'));
  });

  test('refuses file content that is not base64', () => {
    expect(() =>
      parseUpMessage(
        JSON.stringify({
          type: 'files',
          requestId: 'r1',
          files: [{ path: 'a', contentType: 'text/plain', content: '%%%' }],
        }),
      ),
    ).toThrow(new RunnerProtocolError('files.files.0.content must be base64'));
  });
});

test('names the protocol version the gateway and runner agree on', () => {
  expect(runnerProtocol).toBe('cerebra-runner.v1');
});
