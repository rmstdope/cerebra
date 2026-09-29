// @vitest-environment node
import { readFileSync } from 'node:fs';
import type {
  CanUseTool,
  Options,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, StartMessage } from '@cerebra/shared';
import { describe, expect, test, vi } from 'vitest';

import {
  claudeEnvironment,
  claudeQueryOptions,
  runClaude,
  type ClaudeQuery,
} from './claude-adapter.js';
import { createInputQueue } from './input-queue.js';

function recording(name: string): SDKMessage[] {
  const url = new URL(`./recordings/${name}.jsonl`, import.meta.url);
  return readFileSync(url, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as SDKMessage | { canUseTool: unknown })
    .filter((line): line is SDKMessage => !('canUseTool' in line));
}

/** The messages of one turn: everything up to and including its result. */
function turns(messages: SDKMessage[]): SDKMessage[][] {
  const split: SDKMessage[][] = [[]];
  for (const message of messages) {
    split.at(-1)?.push(message);
    if (message.type === 'result') {
      split.push([]);
    }
  }
  return split.filter((turn) => turn.length > 0);
}

function start(overrides: Partial<StartMessage> = {}): StartMessage {
  return {
    type: 'start',
    backend: 'claude',
    model: 'claude-haiku-4-5',
    effort: 'high',
    instructions: 'Follow the brief.',
    interactive: true,
    firstMessage: 'Hello',
    resumeSessionId: null,
    mcpServers: {},
    skills: [],
    ...overrides,
  };
}

interface Script {
  readonly prompt: AsyncIterator<SDKUserMessage>;
  readonly options: Options;
  emit(...messages: SDKMessage[]): void;
}

interface FakeQuery {
  readonly query: ClaudeQuery;
  readonly interrupt: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  readonly options: () => Options;
}

/** A query whose output the script writes, reading the prompt as the SDK would. */
function fakeQuery(script: (fake: Script) => Promise<void>): FakeQuery {
  const interrupt = vi.fn(async () => {});
  const close = vi.fn();
  let seen: Options | undefined;
  const query: ClaudeQuery = ({ prompt, options }) => {
    seen = options;
    const output = createInputQueue<SDKMessage>();
    const failure = { error: undefined as unknown };
    void script({
      prompt: prompt[Symbol.asyncIterator](),
      options,
      emit: (...messages) =>
        messages.forEach((message) => output.push(message)),
    }).then(
      () => output.close(),
      (error: unknown) => {
        failure.error = error;
        output.close();
      },
    );
    return {
      async *[Symbol.asyncIterator]() {
        yield* output;
        if (failure.error !== undefined) {
          throw failure.error;
        }
      },
      interrupt,
      close: () => {
        close();
        output.close();
      },
    };
  };
  return {
    query,
    interrupt,
    close,
    options: () => {
      if (seen === undefined) {
        throw new Error('The query was not started');
      }
      return seen;
    },
  };
}

function textOf(message: SDKUserMessage | undefined): unknown {
  return message?.message.content;
}

/** Resolves once the run has emitted an event matching the predicate. */
function recorder(): {
  events: AgentEvent[];
  emit: (event: AgentEvent) => void;
  waitFor: (predicate: (event: AgentEvent) => boolean) => Promise<void>;
} {
  const events: AgentEvent[] = [];
  const waiters: {
    predicate: (event: AgentEvent) => boolean;
    resolve: () => void;
  }[] = [];
  return {
    events,
    emit(event) {
      events.push(event);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(event)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
    },
    waitFor(predicate) {
      if (events.some(predicate)) {
        return Promise.resolve();
      }
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
  };
}

const kinds = (events: AgentEvent[]): string[] =>
  events.map((event) =>
    event.kind === 'status'
      ? `status:${event.status}`
      : event.kind === 'result'
        ? `result:${event.end}`
        : event.kind,
  );

describe('a Claude run', () => {
  test('holds a conversation turn by turn, waiting for the navigator between turns, until stopped', async () => {
    const [first, second] = turns(recording('tools'));
    const prompts: unknown[] = [];
    const fake = fakeQuery(async ({ prompt, emit }) => {
      prompts.push(textOf((await prompt.next()).value));
      emit(...(first ?? []));
      prompts.push(textOf((await prompt.next()).value));
      emit(...(second ?? []));
      await prompt.next();
    });
    const record = recorder();

    const run = runClaude({
      start: start(),
      query: fake.query,
      env: {},
      emit: record.emit,
    });
    await record.waitFor((event) => event.kind === 'result');
    run.send('Now reply with exactly: done');
    await record.waitFor(
      (event) => event.kind === 'result' && event.usage.costUsd < 0.01,
    );
    await record.waitFor(
      (event) =>
        event.kind === 'status' &&
        event.status === 'awaiting_input' &&
        record.events.filter((seen) => seen.kind === 'result').length === 2,
    );
    run.stop();

    await expect(run.done).resolves.toBe('stopped');
    expect(prompts).toEqual(['Hello', 'Now reply with exactly: done']);
    expect(kinds(record.events)).toEqual([
      'user_message',
      'status:active',
      'tool_call',
      'tool_result',
      'message',
      'result:turn',
      'status:awaiting_input',
      'user_message',
      'status:active',
      'message',
      'result:turn',
      'status:awaiting_input',
      'result:stopped',
    ]);
    expect(record.events[0]).toEqual({ kind: 'user_message', text: 'Hello' });
    expect(record.events.at(-1)).toEqual({
      kind: 'result',
      end: 'stopped',
      sessionId: 'session-0001',
      usage: { costUsd: 0, models: {} },
    });
    expect(fake.close).toHaveBeenCalled();
  });

  test('ends a non-interactive run after its first turn', async () => {
    const [first] = turns(recording('tools'));
    let promptEnded = false;
    const fake = fakeQuery(async ({ prompt, emit }) => {
      await prompt.next();
      emit(...(first ?? []));
      promptEnded = (await prompt.next()).done === true;
    });
    const record = recorder();

    const run = runClaude({
      start: start({ interactive: false }),
      query: fake.query,
      env: {},
      emit: record.emit,
    });

    await expect(run.done).resolves.toBe('completed');
    expect(promptEnded).toBe(true);
    expect(kinds(record.events).slice(-2)).toEqual([
      'message',
      'result:completed',
    ]);
  });

  test('asks the navigator a question and answers Claude with their choice', async () => {
    const messages = recording('question');
    const toolUse = messages.findIndex(
      (message) =>
        message.type === 'assistant' &&
        JSON.stringify(message.message.content).includes('AskUserQuestion'),
    );
    const input = {
      questions: [
        {
          question: 'Which colour do you prefer?',
          header: 'Color',
          options: [
            { label: 'Red', description: 'The color red', preview: 'r' },
            { label: 'Blue', description: 'The color blue' },
          ],
          multiSelect: false,
        },
      ],
    };
    let permission: unknown;
    const fake = fakeQuery(async ({ prompt, options, emit }) => {
      await prompt.next();
      emit(...messages.slice(0, toolUse + 1));
      permission = await (options.canUseTool as CanUseTool)(
        'AskUserQuestion',
        input,
        {
          signal: new AbortController().signal,
          toolUseID: 'toolu_01JYcxaqPWs7iNiCrBbxovjH',
        } as Parameters<CanUseTool>[2],
      );
      emit(...messages.slice(toolUse + 1));
      await prompt.next();
    });
    const record = recorder();
    const run = runClaude({
      start: start(),
      query: fake.query,
      env: {},
      emit: record.emit,
    });

    await record.waitFor((event) => event.kind === 'question');
    run.answer('toolu_01JYcxaqPWs7iNiCrBbxovjH', {
      'Which colour do you prefer?': 'Blue',
    });
    await record.waitFor((event) => event.kind === 'result');
    run.stop();
    await run.done;

    expect(permission).toEqual({
      behavior: 'allow',
      updatedInput: {
        ...input,
        answers: { 'Which colour do you prefer?': 'Blue' },
      },
    });
    expect(kinds(record.events)).toEqual([
      'user_message',
      'status:active',
      'question',
      'status:awaiting_input',
      'answer',
      'status:active',
      'message',
      'result:turn',
      'status:awaiting_input',
      'result:stopped',
    ]);
    expect(record.events[2]).toEqual({
      kind: 'question',
      questionId: 'toolu_01JYcxaqPWs7iNiCrBbxovjH',
      questions: [
        {
          question: 'Which colour do you prefer?',
          header: 'Color',
          multiSelect: false,
          options: [
            { label: 'Red', description: 'The color red' },
            { label: 'Blue', description: 'The color blue' },
          ],
        },
      ],
    });
    expect(record.events[4]).toEqual({
      kind: 'answer',
      questionId: 'toolu_01JYcxaqPWs7iNiCrBbxovjH',
      answers: { 'Which colour do you prefer?': 'Blue' },
    });
  });

  test('withdraws a waiting question when the run is stopped', async () => {
    let permission: unknown;
    const fake = fakeQuery(async ({ prompt, options }) => {
      await prompt.next();
      permission = await (options.canUseTool as CanUseTool)(
        'AskUserQuestion',
        { questions: [] },
        {
          signal: new AbortController().signal,
          toolUseID: 'toolu_q',
        } as Parameters<CanUseTool>[2],
      );
    });
    const record = recorder();
    const run = runClaude({
      start: start(),
      query: fake.query,
      env: {},
      emit: record.emit,
    });

    await record.waitFor((event) => event.kind === 'question');
    run.stop();

    await expect(run.done).resolves.toBe('stopped');
    await vi.waitFor(() =>
      expect(permission).toEqual({
        behavior: 'deny',
        message: 'The question was withdrawn',
      }),
    );
  });

  test('allows every other tool as Claude asked for it', async () => {
    let permission: unknown;
    const fake = fakeQuery(async ({ prompt, options }) => {
      await prompt.next();
      permission = await (options.canUseTool as CanUseTool)(
        'Bash',
        { command: 'rm -rf build' },
        {
          signal: new AbortController().signal,
          toolUseID: 'toolu_b',
        } as Parameters<CanUseTool>[2],
      );
    });
    const run = runClaude({
      start: start(),
      query: fake.query,
      env: {},
      emit: () => {},
    });
    await run.done;

    expect(permission).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'rm -rf build' },
    });
  });

  test('refuses an answer to no waiting question, and a message after the run ended', async () => {
    const fake = fakeQuery(async ({ prompt }) => {
      await prompt.next();
    });
    const run = runClaude({
      start: start(),
      query: fake.query,
      env: {},
      emit: () => {},
    });

    expect(() => run.answer('toolu_none', {})).toThrow(
      'No question is waiting with id toolu_none',
    );
    await run.done;
    expect(() => run.send('late')).toThrow('The run has ended');
  });

  test('passes a message sent mid-turn straight to the live query', async () => {
    const [first] = turns(recording('tools'));
    const prompts: unknown[] = [];
    const fake = fakeQuery(async ({ prompt, emit }) => {
      prompts.push(textOf((await prompt.next()).value));
      emit(...(first ?? []).slice(0, 4));
      prompts.push(textOf((await prompt.next()).value));
      emit(...(first ?? []).slice(4));
      await prompt.next();
    });
    const record = recorder();
    const run = runClaude({
      start: start(),
      query: fake.query,
      env: {},
      emit: record.emit,
    });

    await record.waitFor((event) => event.kind === 'tool_call');
    run.send('Use printf instead');
    await record.waitFor((event) => event.kind === 'result');
    run.stop();
    await run.done;

    expect(prompts).toEqual(['Hello', 'Use printf instead']);
    expect(kinds(record.events)).toEqual([
      'user_message',
      'status:active',
      'tool_call',
      'user_message',
      'tool_result',
      'message',
      'result:turn',
      'status:awaiting_input',
      'result:stopped',
    ]);
  });

  test('ends the turn it interrupts without failing the run', async () => {
    const [interrupted, next] = turns(recording('interrupt'));
    const fake = fakeQuery(async ({ prompt, emit }) => {
      await prompt.next();
      emit(...(interrupted ?? []).slice(0, 7));
      await vi.waitFor(() => expect(fake.interrupt).toHaveBeenCalled());
      emit(...(interrupted ?? []).slice(7));
      await prompt.next();
      emit(...(next ?? []));
      await prompt.next();
    });
    const record = recorder();
    const run = runClaude({
      start: start(),
      query: fake.query,
      env: {},
      emit: record.emit,
    });

    await record.waitFor((event) => event.kind === 'tool_call');
    await run.interrupt();
    await record.waitFor((event) => event.kind === 'result');
    run.send('Say hi.');
    await record.waitFor(
      (event) => event.kind === 'message' && event.text.startsWith('Hi'),
    );
    await record.waitFor(
      (event) =>
        event.kind === 'result' &&
        record.events.filter((seen) => seen.kind === 'result').length === 2,
    );
    run.stop();

    await expect(run.done).resolves.toBe('stopped');
    const results = record.events.filter((event) => event.kind === 'result');
    expect(results[0]).toMatchObject({ end: 'turn' });
    expect(results[0]).not.toHaveProperty('error');
    expect(results[1]).toMatchObject({ end: 'turn' });
  });

  test('fails the run when stopped for a reason', async () => {
    const fake = fakeQuery(async ({ prompt }) => {
      await prompt.next();
      await prompt.next();
    });
    const record = recorder();
    const run = runClaude({
      start: start(),
      query: fake.query,
      env: {},
      emit: record.emit,
    });

    run.stop('The gateway went away');

    await expect(run.done).resolves.toBe('failed');
    expect(record.events.at(-1)).toMatchObject({
      end: 'failed',
      error: 'The gateway went away',
    });
    expect(fake.close).toHaveBeenCalled();
  });

  test('fails the run when the SDK throws, naming the error', async () => {
    const fake = fakeQuery(async ({ prompt }) => {
      await prompt.next();
      throw new Error('Claude Code process exited with code 1');
    });
    const record = recorder();
    const run = runClaude({
      start: start(),
      query: fake.query,
      env: {},
      emit: record.emit,
    });

    await expect(run.done).resolves.toBe('failed');
    expect(record.events.at(-1)).toEqual({
      kind: 'result',
      end: 'failed',
      usage: { costUsd: 0, models: {} },
      error: 'Claude Code process exited with code 1',
    });
  });

  test('fails the run when Claude ends without finishing it', async () => {
    const fake = fakeQuery(async ({ prompt }) => {
      await prompt.next();
    });
    const record = recorder();
    const run = runClaude({
      start: start(),
      query: fake.query,
      env: {},
      emit: record.emit,
    });

    await expect(run.done).resolves.toBe('failed');
    expect(record.events.at(-1)).toMatchObject({
      end: 'failed',
      error: 'Claude ended before the run finished',
    });
  });

  test('fails the run on an error result', async () => {
    const fake = fakeQuery(async ({ prompt, emit }) => {
      await prompt.next();
      emit({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        errors: ['Reached the turn limit'],
        total_cost_usd: 0.2,
        modelUsage: {},
        session_id: 'session-9',
      } as unknown as SDKMessage);
      await prompt.next();
    });
    const run = runClaude({
      start: start(),
      query: fake.query,
      env: {},
      emit: () => {},
    });

    await expect(run.done).resolves.toBe('failed');
  });
});

describe('the Claude query options', () => {
  test('run Claude in default mode with the run settings, skills and tools', () => {
    const canUseTool: CanUseTool = async () => ({ behavior: 'allow' });

    const options = claudeQueryOptions(
      start({
        resumeSessionId: 'session-1',
        mcpServers: {
          cerebra: {
            type: 'http',
            url: 'http://cerebra:3000/mcp',
            headers: { Authorization: 'Bearer run-token' },
          },
        },
      }),
      { env: { PATH: '/usr/bin' }, canUseTool },
    );

    expect(options).toEqual({
      cwd: '/work',
      model: 'claude-haiku-4-5',
      effort: 'high',
      permissionMode: 'default',
      canUseTool,
      settingSources: ['user', 'project', 'local'],
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: 'Follow the brief.',
      },
      mcpServers: {
        cerebra: {
          type: 'http',
          url: 'http://cerebra:3000/mcp',
          headers: { Authorization: 'Bearer run-token' },
        },
      },
      env: { PATH: '/usr/bin' },
      resume: 'session-1',
    });
  });

  test('refuse an effort Claude does not know', () => {
    expect(() =>
      claudeQueryOptions(start({ effort: 'extreme' }), {
        env: {},
        canUseTool: async () => ({ behavior: 'allow' }),
      }),
    ).toThrow('Unsupported effort: extreme');
  });

  test('keep the subscription token but drop what would switch Claude to bare or API-key mode', () => {
    expect(
      claudeEnvironment({
        PATH: '/usr/bin',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
        CLAUDE_CONFIG_DIR: '/cli-state',
        CLAUDE_CODE_SIMPLE: '1',
        ANTHROPIC_API_KEY: 'sk-ant',
        CEREBRA_RUN_TOKEN: 'run-token',
      }),
    ).toEqual({
      PATH: '/usr/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      CLAUDE_CONFIG_DIR: '/cli-state',
    });
  });
});
