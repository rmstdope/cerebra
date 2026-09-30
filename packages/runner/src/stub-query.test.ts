// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, StartMessage } from '@cerebra/shared';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { runClaude } from './claude-adapter.js';
import {
  createStubQuery,
  stubScriptFile,
  type StubCommand,
  type StubScript,
} from './stub-query.js';

let checkout: string;

beforeEach(async () => {
  checkout = await mkdtemp(join(tmpdir(), 'stub-query-'));
});

afterEach(async () => {
  await rm(checkout, { recursive: true, force: true });
});

interface Call {
  readonly name: string;
  readonly arguments: unknown;
  readonly authorization: string | null;
}

/** The board's MCP endpoint, answering get_item with the item's state and history. */
function board(
  state: string,
  entered: number,
  refuse: readonly string[] = [],
): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fake = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      params: { name: string; arguments: unknown };
    };
    const headers = new Headers(init?.headers);
    calls.push({
      name: body.params.name,
      arguments: body.params.arguments,
      authorization: headers.get('authorization'),
    });
    const refused = refuse.includes(body.params.name);
    const value =
      body.params.name === 'get_item'
        ? {
            item: { id: 'item-1', key: 'WEB-7', state },
            history: Array.from({ length: entered }, () => ({
              toState: state,
            })),
          }
        : refused
          ? { error: 'refused', message: 'Not now.' }
          : { ok: true };
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(value) }],
          isError: refused,
        },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  return { fetch: fake as typeof fetch, calls };
}

function commands(outputs: Record<string, string> = {}, failing = '') {
  const ran: { argv: readonly string[]; cwd: string }[] = [];
  const exec: StubCommand = async (argv, cwd) => {
    ran.push({ argv, cwd });
    const line = argv.join(' ');
    return line === failing
      ? { code: 1, output: 'it broke' }
      : { code: 0, output: outputs[line] ?? '' };
  };
  return { exec, ran };
}

const start: StartMessage = {
  type: 'start',
  backend: 'claude',
  model: 'claude-haiku-4-5',
  effort: 'high',
  instructions: 'Build it.',
  interactive: false,
  firstMessage: 'Build the item you hold.',
  resumeSessionId: null,
  mcpServers: {
    cerebra: {
      url: 'http://backend/mcp',
      headers: { Authorization: 'Bearer run-token' },
    },
  },
  skills: [],
};

async function run(
  script: StubScript | undefined,
  dependencies: { fetch: typeof fetch; exec: StubCommand },
): Promise<AgentEvent[]> {
  if (script !== undefined) {
    await writeFile(join(checkout, stubScriptFile), JSON.stringify(script));
  }
  const events: AgentEvent[] = [];
  const claude = runClaude({
    start,
    query: createStubQuery(dependencies),
    env: {},
    cwd: checkout,
    emit: (event) => events.push(event),
  });
  await claude.done;
  return events;
}

const script: StubScript = {
  building: [
    [
      { say: 'First build of {{key}}.' },
      { run: ['git', 'rev-parse', 'HEAD'], as: 'head' },
      {
        tool: 'transition',
        arguments: { to: 'review_ready', record: { head: '{{head}}' } },
      },
    ],
    [{ say: 'Rework of {{key}}.' }],
  ],
  reviewing: [[{ say: 'Reviewing.' }]],
};

test('replays the entry for the held item’s state and round as ordinary events', async () => {
  const mcp = board('building', 1);
  const shell = commands({ 'git rev-parse HEAD': 'abc1234\n' });

  const events = await run(script, { fetch: mcp.fetch, exec: shell.exec });

  expect(mcp.calls).toEqual([
    { name: 'get_item', arguments: {}, authorization: 'Bearer run-token' },
    {
      name: 'transition',
      arguments: { to: 'review_ready', record: { head: 'abc1234' } },
      authorization: 'Bearer run-token',
    },
  ]);
  expect(shell.ran).toEqual([
    { argv: ['git', 'rev-parse', 'HEAD'], cwd: checkout },
  ]);
  expect(events).toContainEqual({
    kind: 'message',
    text: 'First build of WEB-7.',
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: 'tool_call',
      name: 'mcp__cerebra__transition',
    }),
  );
  expect(events.at(-1)).toEqual(
    expect.objectContaining({ kind: 'result', end: 'completed' }),
  );
});

test('a later round replays the entry for the times the item has entered that state', async () => {
  const mcp = board('building', 2);

  const events = await run(script, { fetch: mcp.fetch, exec: commands().exec });

  expect(events).toContainEqual({ kind: 'message', text: 'Rework of WEB-7.' });
  expect(mcp.calls.map((call) => call.name)).toEqual(['get_item']);
});

test('a round past the script repeats its last entry', async () => {
  const mcp = board('reviewing', 3);

  const events = await run(script, { fetch: mcp.fetch, exec: commands().exec });

  expect(events).toContainEqual({ kind: 'message', text: 'Reviewing.' });
});

test('a refused board call fails the run with the board’s reason', async () => {
  const mcp = board('building', 1, ['transition']);
  const shell = commands({ 'git rev-parse HEAD': 'abc1234' });

  const events = await run(script, { fetch: mcp.fetch, exec: shell.exec });

  expect(events.at(-1)).toEqual(
    expect.objectContaining({
      kind: 'result',
      end: 'failed',
      error: expect.stringContaining('Not now.'),
    }),
  );
});

test('a failing command fails the run with its output', async () => {
  const mcp = board('building', 1);
  const shell = commands({}, 'git rev-parse HEAD');

  const events = await run(script, { fetch: mcp.fetch, exec: shell.exec });

  expect(mcp.calls.map((call) => call.name)).toEqual(['get_item']);
  expect(events.at(-1)).toEqual(
    expect.objectContaining({
      kind: 'result',
      end: 'failed',
      error: expect.stringContaining('it broke'),
    }),
  );
});

test('a checkout without a script fails the run naming the file', async () => {
  const mcp = board('building', 1);

  const events = await run(undefined, {
    fetch: mcp.fetch,
    exec: commands().exec,
  });

  expect(events.at(-1)).toEqual(
    expect.objectContaining({
      kind: 'result',
      end: 'failed',
      error: expect.stringContaining(stubScriptFile),
    }),
  );
});

test('a state the script has no entry for fails the run naming the state', async () => {
  const mcp = board('verifying', 1);

  const events = await run(script, { fetch: mcp.fetch, exec: commands().exec });

  expect(events.at(-1)).toEqual(
    expect.objectContaining({
      kind: 'result',
      end: 'failed',
      error: expect.stringContaining('verifying'),
    }),
  );
});

test('an SDK message stream: init first, result last', async () => {
  const mcp = board('reviewing', 1);
  const messages: SDKMessage[] = [];
  const query = createStubQuery({ fetch: mcp.fetch, exec: commands().exec });
  await writeFile(join(checkout, stubScriptFile), JSON.stringify(script));
  for await (const message of query({
    prompt: (async function* () {})(),
    options: {
      cwd: checkout,
      mcpServers: {
        cerebra: { type: 'http', url: 'http://backend/mcp', headers: {} },
      },
    },
  })) {
    messages.push(message);
  }
  expect(messages[0]).toEqual(
    expect.objectContaining({ type: 'system', subtype: 'init' }),
  );
  expect(messages.at(-1)).toEqual(
    expect.objectContaining({ type: 'result', subtype: 'success' }),
  );
});
