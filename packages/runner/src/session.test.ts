// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CanUseTool,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  parseUpMessage,
  runnerProtocol,
  type AgentEvent,
  type DownMessage,
  type StartMessage,
  type UpMessage,
} from '@cerebra/shared';
import { afterEach, describe, expect, test } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

import type { ClaudeQuery } from './claude-adapter.js';
import { runRunnerSession } from './session.js';

const start: StartMessage = {
  type: 'start',
  backend: 'claude',
  model: 'claude-haiku-4-5',
  effort: 'low',
  instructions: 'Be brief.',
  interactive: true,
  firstMessage: 'Hello',
  resumeSessionId: null,
  mcpServers: {},
  skills: [],
};

/** A Claude that echoes each message as one turn, and asks when told to. */
function echoingClaude(): {
  query: ClaudeQuery;
  prompts: string[];
  closed: () => boolean;
} {
  const prompts: string[] = [];
  let closed = false;
  let cost = 0;
  const reply = (text: string): SDKMessage =>
    ({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text }] },
      session_id: 'session-1',
    }) as unknown as SDKMessage;
  const result = (): SDKMessage => {
    cost += 0.25;
    return {
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: cost,
      modelUsage: {},
      session_id: 'session-1',
    } as unknown as SDKMessage;
  };
  const query: ClaudeQuery = ({ prompt, options }) => {
    async function* conversation(): AsyncGenerator<SDKMessage> {
      for await (const message of prompt as AsyncIterable<SDKUserMessage>) {
        const text = String(message.message.content);
        prompts.push(text);
        if (text === 'ask') {
          const permission = await (options.canUseTool as CanUseTool)(
            'AskUserQuestion',
            {
              questions: [
                {
                  question: 'Colour?',
                  header: 'Colour',
                  multiSelect: false,
                  options: [{ label: 'Red', description: 'Warm' }],
                },
              ],
            },
            {
              signal: new AbortController().signal,
              toolUseID: 'toolu_q',
            } as Parameters<CanUseTool>[2],
          );
          yield reply(
            permission.behavior === 'allow'
              ? JSON.stringify(permission.updatedInput?.answers)
              : 'denied',
          );
        } else {
          yield reply(`echo: ${text}`);
        }
        yield result();
      }
    }
    return Object.assign(conversation(), {
      interrupt: async () => {},
      close: () => {
        closed = true;
      },
    });
  };
  return { query, prompts, closed: () => closed };
}

interface Gateway {
  readonly url: string;
  readonly requests: IncomingMessage[];
  /** Resolves with the next runner to connect. */
  connection(): Promise<Runner>;
  close(): Promise<void>;
}

interface Runner {
  readonly socket: WebSocket;
  readonly received: UpMessage[];
  send(message: DownMessage | string): void;
  waitFor(predicate: (event: AgentEvent) => boolean): Promise<UpMessage>;
  closed: Promise<void>;
}

const gateways: Gateway[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function gateway(): Promise<Gateway> {
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    handleProtocols: (protocols) =>
      protocols.has(runnerProtocol) ? runnerProtocol : false,
  });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const requests: IncomingMessage[] = [];
  const waiting: ((runner: Runner) => void)[] = [];
  server.on('connection', (socket, request) => {
    requests.push(request);
    const received: UpMessage[] = [];
    const waiters: {
      predicate: (event: AgentEvent) => boolean;
      resolve: (message: UpMessage) => void;
    }[] = [];
    socket.on('message', (data) => {
      const message = parseUpMessage(String(data));
      received.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(message.event)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    });
    const runner: Runner = {
      socket,
      received,
      send: (message) =>
        socket.send(
          typeof message === 'string' ? message : JSON.stringify(message),
        ),
      waitFor: (predicate) => {
        const seen = received.find((message) => predicate(message.event));
        return seen
          ? Promise.resolve(seen)
          : new Promise((resolve) => waiters.push({ predicate, resolve }));
      },
      closed: new Promise((resolve) => socket.once('close', () => resolve())),
    };
    waiting.shift()?.(runner);
  });
  const { port } = server.address() as AddressInfo;
  const created: Gateway = {
    url: `ws://127.0.0.1:${port}/runner`,
    requests,
    connection: () => new Promise((resolve) => waiting.push(resolve)),
    close: () =>
      new Promise((resolve) => {
        for (const client of server.clients) {
          client.terminate();
        }
        server.close(() => resolve());
      }),
  };
  gateways.push(created);
  return created;
}

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'cerebra-session-'));
  directories.push(path);
  return path;
}

async function session(
  url: string,
  claude: ReturnType<typeof echoingClaude>,
  paths?: { checkout: string; configDir: string },
): Promise<ReturnType<typeof runRunnerSession>> {
  return runRunnerSession({
    gatewayUrl: url,
    token: 'run-token-1',
    configDir: paths?.configDir ?? (await directory()),
    checkout: paths?.checkout ?? (await directory()),
    query: claude.query,
    env: {},
  });
}

const isResult = (end: string) => (event: AgentEvent) =>
  event.kind === 'result' && event.end === end;

describe('a runner session', () => {
  test('connects with its run token, holds the conversation, and numbers every event', async () => {
    const gate = await gateway();
    const claude = echoingClaude();
    const connecting = gate.connection();
    const ending = session(gate.url, claude);
    const runner = await connecting;

    runner.send(start);
    await runner.waitFor(isResult('turn'));
    runner.send({ type: 'user_message', text: 'Again' });
    await runner.waitFor(
      (event) => event.kind === 'message' && event.text === 'echo: Again',
    );
    await runner.waitFor(
      (event) =>
        event.kind === 'status' &&
        event.status === 'awaiting_input' &&
        runner.received.filter((message) => message.event.kind === 'result')
          .length === 2,
    );
    runner.send({ type: 'stop' });

    await expect(ending).resolves.toBe('stopped');
    await runner.closed;
    expect(gate.requests[0]?.headers.authorization).toBe('Bearer run-token-1');
    expect(gate.requests[0]?.headers['sec-websocket-protocol']).toBe(
      runnerProtocol,
    );
    expect(claude.prompts).toEqual(['Hello', 'Again']);
    expect(runner.received.map((message) => message.seq)).toEqual(
      runner.received.map((_, index) => index + 1),
    );
    expect(runner.received.map((message) => message.event.kind)).toEqual([
      'user_message',
      'status',
      'message',
      'result',
      'status',
      'user_message',
      'status',
      'message',
      'result',
      'status',
      'result',
    ]);
    expect(runner.received[8]?.event).toMatchObject({
      kind: 'result',
      end: 'turn',
      sessionId: 'session-1',
      usage: { costUsd: 0.25 },
    });
  });

  test('relays a question to the gateway and its answer back to Claude', async () => {
    const gate = await gateway();
    const claude = echoingClaude();
    const connecting = gate.connection();
    const ending = session(gate.url, claude);
    const runner = await connecting;

    runner.send({ ...start, firstMessage: 'ask' });
    const question = await runner.waitFor((event) => event.kind === 'question');
    expect(question.event).toMatchObject({ questionId: 'toolu_q' });
    runner.send({
      type: 'answer',
      questionId: 'toolu_q',
      answers: { 'Colour?': 'Red' },
    });
    const reply = await runner.waitFor((event) => event.kind === 'message');
    runner.send({ type: 'stop' });
    await ending;

    expect(reply.event).toEqual({
      kind: 'message',
      text: JSON.stringify({ 'Colour?': 'Red' }),
    });
  });

  test('reports an answer to no waiting question without ending the run', async () => {
    const gate = await gateway();
    const claude = echoingClaude();
    const connecting = gate.connection();
    const ending = session(gate.url, claude);
    const runner = await connecting;

    runner.send(start);
    await runner.waitFor(isResult('turn'));
    runner.send({ type: 'answer', questionId: 'toolu_x', answers: {} });
    const error = await runner.waitFor((event) => event.kind === 'error');
    runner.send({ type: 'stop' });

    await expect(ending).resolves.toBe('stopped');
    expect(error.event).toEqual({
      kind: 'error',
      message: 'No question is waiting with id toolu_x',
    });
  });

  test('refuses a backend it does not drive', async () => {
    const gate = await gateway();
    const claude = echoingClaude();
    const connecting = gate.connection();
    const ending = session(gate.url, claude);
    const runner = await connecting;

    runner.send(JSON.stringify({ ...start, backend: 'copilot' }));

    await expect(ending).resolves.toBe('failed');
    await runner.closed;
    expect(runner.received.map((message) => message.event)).toEqual([
      {
        kind: 'result',
        end: 'failed',
        usage: { costUsd: 0, models: {} },
        error:
          'The gateway sent a message the runner cannot read: Unsupported backend: copilot',
      },
    ]);
    expect(claude.prompts).toEqual([]);
  });

  test('fails the run when the gateway sends something unreadable mid-run', async () => {
    const gate = await gateway();
    const claude = echoingClaude();
    const connecting = gate.connection();
    const ending = session(gate.url, claude);
    const runner = await connecting;

    runner.send(start);
    await runner.waitFor(isResult('turn'));
    runner.send('{"type":"dance"}');

    await expect(ending).resolves.toBe('failed');
    await runner.closed;
    expect(
      runner.received.slice(-2).map((message) => message.event),
    ).toMatchObject([
      {
        kind: 'error',
        message:
          'The gateway sent a message the runner cannot read: Unknown message type: dance',
      },
      {
        kind: 'result',
        end: 'failed',
        error:
          'The gateway sent a message the runner cannot read: Unknown message type: dance',
      },
    ]);
  });

  test('fails the run and stops Claude when the gateway goes away', async () => {
    const gate = await gateway();
    const claude = echoingClaude();
    const connecting = gate.connection();
    const ending = session(gate.url, claude);
    const runner = await connecting;

    runner.send(start);
    await runner.waitFor(isResult('turn'));
    runner.socket.close();

    await expect(ending).resolves.toBe('failed');
    expect(claude.closed()).toBe(true);
  });

  test('installs the listed project skills before Claude starts, and fails on a missing one', async () => {
    const gate = await gateway();
    const checkout = await directory();
    const configDir = await directory();
    await mkdir(join(checkout, '.cerebro', 'skills', 'review'), {
      recursive: true,
    });
    await writeFile(
      join(checkout, '.cerebro', 'skills', 'review', 'SKILL.md'),
      '# Review',
    );

    const connecting = gate.connection();
    const ending = session(gate.url, echoingClaude(), { checkout, configDir });
    const runner = await connecting;
    runner.send({ ...start, skills: ['review'] });
    await runner.waitFor(isResult('turn'));
    runner.send({ type: 'stop' });
    await ending;

    await expect(
      readFile(join(configDir, 'skills', 'review', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('# Review');

    const again = gate.connection();
    const failing = session(gate.url, echoingClaude(), { checkout, configDir });
    const second = await again;
    second.send({ ...start, skills: ['absent'] });

    await expect(failing).resolves.toBe('failed');
    await second.closed;
    expect(second.received.at(-1)?.event).toMatchObject({
      end: 'failed',
      error:
        'Skill absent is not in the checkout at .cerebro/skills/absent/SKILL.md',
    });
  });

  test('fails when it cannot reach the gateway', async () => {
    const gate = await gateway();
    const url = gate.url;
    await gate.close();

    await expect(session(url, echoingClaude())).resolves.toBe('failed');
  });
});
