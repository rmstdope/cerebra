// @vitest-environment node
import { readFileSync } from 'node:fs';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@cerebra/shared';
import { describe, expect, test } from 'vitest';

import { createClaudeNormalizer } from './claude-normalizer.js';

// Recorded from the real SDK in default mode on a subscription login; paths and ids scrubbed.
function recording(name: string): SDKMessage[] {
  const url = new URL(`./recordings/${name}.jsonl`, import.meta.url);
  return readFileSync(url, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as SDKMessage | { canUseTool: unknown })
    .filter((line): line is SDKMessage => !('canUseTool' in line));
}

function replay(
  name: string,
  interactive = true,
): { events: AgentEvent[]; sessionId: string | undefined } {
  const normalizer = createClaudeNormalizer({ interactive });
  const events = recording(name).flatMap((message) =>
    normalizer.translate(message),
  );
  return { events, sessionId: normalizer.sessionId() };
}

const haiku = 'claude-haiku-4-5-20251001';

describe('the Claude normalizer', () => {
  test('turns a tool call, its result and the reply into events, and each turn its own spend', () => {
    const { events, sessionId } = replay('tools');

    expect(sessionId).toBe('session-0001');
    // Thinking arrives with its text withheld, so it has nothing to show.
    expect(events.map((event) => event.kind)).toEqual([
      'tool_call',
      'tool_result',
      'message',
      'result',
      'message',
      'result',
    ]);
    expect(events[0]).toEqual({
      kind: 'tool_call',
      toolCallId: 'toolu_01Ri3bsDks7DSMnX9P6Fxv2N',
      name: 'Bash',
      input: { command: 'echo cerebra', description: 'Print the word cerebra' },
    });
    expect(events[1]).toEqual({
      kind: 'tool_result',
      toolCallId: 'toolu_01Ri3bsDks7DSMnX9P6Fxv2N',
      content: 'cerebra',
      isError: false,
    });
    expect(events[2]).toEqual({
      kind: 'message',
      text: 'The command successfully printed "cerebra" to the output.',
    });
    const [first, second] = events.filter((event) => event.kind === 'result');
    expect(first).toEqual({
      kind: 'result',
      end: 'turn',
      sessionId: 'session-0001',
      usage: {
        costUsd: 0.0366041,
        models: {
          [haiku]: {
            inputTokens: 930,
            outputTokens: 187,
            cacheReadInputTokens: 15491,
            cacheCreationInputTokens: 16595,
          },
        },
      },
    });
    // The SDK reports totals since the query began; the second result carries only its turn.
    expect(second?.kind === 'result' && second.usage.costUsd).toBeCloseTo(
      0.0386316 - 0.0366041,
      10,
    );
    expect(
      second?.kind === 'result' && second.usage.models[haiku]?.outputTokens,
    ).toBe(223 - 187);
  });

  test('ends a non-interactive run with its first successful result', () => {
    const { events } = replay('tools', false);

    expect(events.find((event) => event.kind === 'result')).toMatchObject({
      end: 'completed',
    });
  });

  test('leaves a question to the permission callback rather than showing it as a tool', () => {
    const { events } = replay('question');

    expect(events.map((event) => event.kind)).toEqual(['message', 'result']);
    expect(events[0]).toEqual({
      kind: 'message',
      text: 'You prefer the color blue.',
    });
  });

  test('brackets a sub-agent and nests what it did under the call that started it', () => {
    const { events } = replay('subagent');
    const agent = 'toolu_01X8yABgEjeneZqKAueLcXN8';

    expect(events).toEqual([
      {
        kind: 'subagent_start',
        toolCallId: agent,
        subagentType: 'general-purpose',
        description: 'Run echo nested command',
      },
      {
        kind: 'tool_call',
        toolCallId: 'toolu_012pbBQFugqhphyyf7kbvasi',
        name: 'Bash',
        input: {
          command: 'echo nested',
          description: "Run echo command with 'nested' argument",
        },
        parentToolCallId: agent,
      },
      {
        kind: 'tool_result',
        toolCallId: 'toolu_012pbBQFugqhphyyf7kbvasi',
        content: 'nested',
        isError: false,
        parentToolCallId: agent,
      },
      { kind: 'subagent_end', toolCallId: agent, isError: false },
      {
        kind: 'message',
        text: 'The subagent successfully executed `echo nested` and returned the output: `nested`.',
      },
      expect.objectContaining({ kind: 'result', end: 'turn' }),
    ]);
  });

  test('fails the run on an error result, naming what went wrong', () => {
    const normalizer = createClaudeNormalizer({ interactive: true });

    const events = normalizer.translate({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Overloaded', 'Retry budget exhausted'],
      total_cost_usd: 0.5,
      modelUsage: {},
      session_id: 'session-0002',
    } as unknown as SDKMessage);

    expect(events).toEqual([
      {
        kind: 'result',
        end: 'failed',
        sessionId: 'session-0002',
        usage: { costUsd: 0.5, models: {} },
        error: 'Overloaded; Retry budget exhausted',
      },
    ]);
  });

  test('fails the run on a successful-looking result the SDK marks as an error', () => {
    const normalizer = createClaudeNormalizer({ interactive: true });

    const [event] = normalizer.translate({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Not logged in · Please run /login',
      total_cost_usd: 0,
      modelUsage: {},
      session_id: 'session-0003',
    } as unknown as SDKMessage);

    expect(event).toMatchObject({
      end: 'failed',
      error: 'Not logged in · Please run /login',
    });
  });

  test('shows thinking whose text is present', () => {
    const normalizer = createClaudeNormalizer({ interactive: true });

    const events = normalizer.translate({
      type: 'assistant',
      parent_tool_use_id: 'toolu_parent',
      message: {
        content: [
          { type: 'thinking', thinking: 'Weigh the options', signature: 's' },
          { type: 'redacted_thinking', data: 'x' },
        ],
      },
    } as unknown as SDKMessage);

    expect(events).toEqual([
      {
        kind: 'thinking',
        text: 'Weigh the options',
        parentToolCallId: 'toolu_parent',
      },
    ]);
  });

  test('reports an assistant error and a failed tool', () => {
    const normalizer = createClaudeNormalizer({ interactive: true });

    const events = [
      ...normalizer.translate({
        type: 'assistant',
        parent_tool_use_id: null,
        error: 'authentication_failed',
        message: { content: [{ type: 'text', text: 'Invalid API key' }] },
      } as unknown as SDKMessage),
      ...normalizer.translate({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_x',
              is_error: true,
              content: [
                { type: 'text', text: 'Exit code 1' },
                { type: 'image', source: {} },
                { type: 'text', text: 'boom' },
              ],
            },
          ],
        },
      } as unknown as SDKMessage),
    ];

    expect(events).toEqual([
      { kind: 'message', text: 'Invalid API key' },
      { kind: 'error', message: 'Claude reported authentication_failed' },
      {
        kind: 'tool_result',
        toolCallId: 'toolu_x',
        content: 'Exit code 1\n[image]\nboom',
        isError: true,
      },
    ]);
  });
});
