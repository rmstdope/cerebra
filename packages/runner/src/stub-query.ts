import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type { ClaudeQuery } from './claude-adapter.js';

/**
 * A stand-in for Claude that replays a script from the checkout instead of calling a model, so
 * the real supervisor can run the whole loop under real Podman with no credential (architecture
 * §13). The script is keyed by the held item's state; each state lists one entry per round.
 */
export const stubScriptFile = '.cerebra-stub.json';

export type StubStep =
  | { readonly say: string }
  | { readonly run: readonly string[]; readonly as?: string }
  | { readonly tool: string; readonly arguments?: unknown };

export type StubScript = Readonly<
  Record<string, readonly (readonly StubStep[])[]>
>;

export type StubCommand = (
  argv: readonly string[],
  cwd: string,
) => Promise<{ readonly code: number; readonly output: string }>;

const runCommand: StubCommand = (argv, cwd) =>
  new Promise((resolve) => {
    const [file = '', ...args] = argv;
    execFile(
      file,
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        const output = `${stdout}${stderr}`;
        resolve({
          code,
          output: error === null ? stdout : output || error.message,
        });
      },
    );
  });

interface Server {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

class StepFailed extends Error {}

function fill(value: unknown, variables: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
      const known = variables.get(name);
      if (known === undefined) {
        throw new StepFailed(
          `The stub script uses an unknown variable ${whole}.`,
        );
      }
      return known;
    });
  }
  if (Array.isArray(value)) {
    return value.map((entry) => fill(entry, variables));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        fill(entry, variables),
      ]),
    );
  }
  return value;
}

export function createStubQuery(
  dependencies: {
    readonly fetch?: typeof fetch;
    readonly exec?: StubCommand;
  } = {},
): ClaudeQuery {
  const call = dependencies.fetch ?? fetch;
  const exec = dependencies.exec ?? runCommand;

  return ({ options }) => {
    const sessionId = `stub-${randomUUID()}`;
    const cwd = options.cwd ?? '/work';
    const server = options.mcpServers?.cerebra as Server | undefined;
    let closed = false;
    let calls = 0;

    async function board(name: string, args: unknown): Promise<string> {
      if (server === undefined) {
        throw new StepFailed('The run has no cerebra MCP server.');
      }
      calls += 1;
      const response = await call(server.url, {
        method: 'POST',
        headers: {
          ...server.headers,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: calls,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      const body = (await response.json()) as {
        result?: { content?: { text?: string }[]; isError?: boolean };
        error?: { message?: string };
      };
      const text = body.result?.content?.[0]?.text;
      if (!response.ok || text === undefined) {
        throw new StepFailed(
          `${name} failed: ${body.error?.message ?? `HTTP ${response.status}`}`,
        );
      }
      if (body.result?.isError === true) {
        throw new StepFailed(`${name} was refused: ${text}`);
      }
      return text;
    }

    function message(fields: Record<string, unknown>): SDKMessage {
      return { ...fields, session_id: sessionId } as unknown as SDKMessage;
    }

    const toolUse = (id: string, name: string, input: unknown) =>
      message({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id, name, input }],
        },
      });

    const toolResult = (id: string, content: string, isError: boolean) =>
      message({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: id,
              content,
              is_error: isError,
            },
          ],
        },
      });

    const failed = (reason: string) =>
      message({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: [reason],
        total_cost_usd: 0,
        modelUsage: {},
      });

    async function* replay(): AsyncGenerator<SDKMessage> {
      yield message({ type: 'system', subtype: 'init', cwd });
      let step = 0;
      const nextId = () => `stub-tool-${(step += 1)}`;
      try {
        const held = nextId();
        yield toolUse(held, 'mcp__cerebra__get_item', {});
        const read = await board('get_item', {});
        yield toolResult(held, read, false);
        const { item, history } = JSON.parse(read) as {
          item: { id: string; key: string; state: string };
          history: { toState: string }[];
        };

        let script: StubScript;
        try {
          script = JSON.parse(
            await readFile(join(cwd, stubScriptFile), 'utf8'),
          ) as StubScript;
        } catch (error) {
          throw new StepFailed(
            `The checkout has no readable ${stubScriptFile}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const rounds = script[item.state];
        if (rounds === undefined || rounds.length === 0) {
          throw new StepFailed(
            `${stubScriptFile} has no entry for an item in ${item.state}.`,
          );
        }
        const round = history.filter(
          (entry) => entry.toState === item.state,
        ).length;
        const steps =
          rounds[Math.min(Math.max(round, 1), rounds.length) - 1] ?? [];
        const variables = new Map([
          ['key', item.key],
          ['item', item.id],
        ]);

        for (const entry of steps) {
          if (closed) {
            return;
          }
          if ('say' in entry) {
            yield message({
              type: 'assistant',
              parent_tool_use_id: null,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: fill(entry.say, variables) }],
              },
            });
          } else if ('run' in entry) {
            const argv = fill(entry.run, variables) as string[];
            const id = nextId();
            yield toolUse(id, 'Bash', { command: argv.join(' ') });
            const { code, output } = await exec(argv, cwd);
            yield toolResult(id, output, code !== 0);
            if (code !== 0) {
              throw new StepFailed(
                `${argv.join(' ')} exited with ${code}: ${output.trim()}`,
              );
            }
            if (entry.as !== undefined) {
              variables.set(entry.as, output.trim());
            }
          } else {
            const args = fill(entry.arguments ?? {}, variables);
            const id = nextId();
            yield toolUse(id, `mcp__cerebra__${entry.tool}`, args);
            try {
              yield toolResult(id, await board(entry.tool, args), false);
            } catch (error) {
              yield toolResult(
                id,
                error instanceof Error ? error.message : String(error),
                true,
              );
              throw error;
            }
          }
        }
        yield message({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'The stub script ran to its end.',
          total_cost_usd: 0,
          modelUsage: {},
        });
      } catch (error) {
        yield failed(error instanceof Error ? error.message : String(error));
      }
    }

    const messages = replay();
    return Object.assign(messages, {
      interrupt: async () => undefined,
      close: () => {
        closed = true;
      },
    });
  };
}
