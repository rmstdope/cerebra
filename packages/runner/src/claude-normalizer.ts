import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent, ModelTokens, Usage } from '@cerebra/shared';

/** The tools through which Claude hands work to a sub-agent. */
const subagentTools = new Set(['Agent', 'Task']);
/** Asked through the permission callback, which emits the question event; its tool rows would repeat it. */
const questionTool = 'AskUserQuestion';

interface Block {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface ModelTotals {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
}

interface Totals {
  readonly costUsd: number;
  readonly models: Readonly<Record<string, ModelTokens>>;
}

export interface ClaudeNormalizer {
  /** Every event one SDK message means, in order; most messages mean none or one. */
  translate(message: SDKMessage): AgentEvent[];
  sessionId(): string | undefined;
}

function blocks(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : [];
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  return blocks(content)
    .map((block) =>
      block.type === 'text' ? String(block.text) : `[${block.type}]`,
    )
    .join('\n');
}

function tokens(totals: ModelTotals): ModelTokens {
  return {
    inputTokens: totals.inputTokens ?? 0,
    outputTokens: totals.outputTokens ?? 0,
    cacheReadInputTokens: totals.cacheReadInputTokens ?? 0,
    cacheCreationInputTokens: totals.cacheCreationInputTokens ?? 0,
  };
}

const tokenKeys = [
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
] as const;

/** The SDK's result totals are since the query began; a turn's usage is what they grew by. */
function spentSince(previous: Totals, current: Totals): Usage {
  const models: Record<string, ModelTokens> = {};
  for (const [model, now] of Object.entries(current.models)) {
    const before = previous.models[model];
    const delta = Object.fromEntries(
      tokenKeys.map((key) => [key, now[key] - (before?.[key] ?? 0)]),
    ) as unknown as ModelTokens;
    if (tokenKeys.some((key) => delta[key] !== 0)) {
      models[model] = delta;
    }
  }
  return { costUsd: current.costUsd - previous.costUsd, models };
}

export function createClaudeNormalizer(options: {
  readonly interactive: boolean;
}): ClaudeNormalizer {
  let sessionId: string | undefined;
  let totals: Totals = { costUsd: 0, models: {} };
  const subagentCalls = new Set<string>();
  const questionCalls = new Set<string>();

  function nested(parent: string | null | undefined): {
    parentToolCallId?: string;
  } {
    return parent ? { parentToolCallId: parent } : {};
  }

  function assistant(
    content: unknown,
    parent: string | null,
    error: string | undefined,
  ): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const block of blocks(content)) {
      if (block.type === 'text' && String(block.text) !== '') {
        events.push({
          kind: 'message',
          text: String(block.text),
          ...nested(parent),
        });
      } else if (block.type === 'thinking' && String(block.thinking) !== '') {
        events.push({
          kind: 'thinking',
          text: String(block.thinking),
          ...nested(parent),
        });
      } else if (block.type === 'tool_use') {
        const id = String(block.id);
        const name = String(block.name);
        const input = (block.input ?? {}) as Record<string, unknown>;
        if (name === questionTool) {
          questionCalls.add(id);
        } else if (subagentTools.has(name)) {
          subagentCalls.add(id);
          events.push({
            kind: 'subagent_start',
            toolCallId: id,
            subagentType:
              typeof input.subagent_type === 'string'
                ? input.subagent_type
                : 'general-purpose',
            description:
              typeof input.description === 'string' ? input.description : '',
            ...nested(parent),
          });
        } else {
          events.push({
            kind: 'tool_call',
            toolCallId: id,
            name,
            input,
            ...nested(parent),
          });
        }
      }
    }
    if (error !== undefined) {
      events.push({
        kind: 'error',
        message: `Claude reported ${error}`,
        ...nested(parent),
      });
    }
    return events;
  }

  function user(content: unknown, parent: string | null): AgentEvent[] {
    const events: AgentEvent[] = [];
    // Plain text here is what was sent to Claude or to a sub-agent; the runner reports what it sent.
    for (const block of blocks(content)) {
      if (block.type !== 'tool_result') {
        continue;
      }
      const id = String(block.tool_use_id);
      const isError = block.is_error === true;
      if (questionCalls.delete(id)) {
        continue;
      }
      if (subagentCalls.delete(id)) {
        events.push({
          kind: 'subagent_end',
          toolCallId: id,
          isError,
          ...nested(parent),
        });
        continue;
      }
      events.push({
        kind: 'tool_result',
        toolCallId: id,
        content: toolResultText(block.content),
        isError,
        ...nested(parent),
      });
    }
    return events;
  }

  function result(message: Record<string, unknown>): AgentEvent {
    const models = Object.fromEntries(
      Object.entries(
        (message.modelUsage ?? {}) as Record<string, ModelTotals>,
      ).map(([model, entry]) => [model, tokens(entry)]),
    );
    const current: Totals = {
      costUsd:
        typeof message.total_cost_usd === 'number' ? message.total_cost_usd : 0,
      models,
    };
    const usage = spentSince(totals, current);
    totals = current;
    const failed = message.subtype !== 'success' || message.is_error === true;
    const errors = Array.isArray(message.errors)
      ? (message.errors as unknown[]).map(String)
      : [];
    const reason =
      errors.length > 0
        ? errors.join('; ')
        : typeof message.result === 'string' && message.result !== ''
          ? message.result
          : String(message.subtype);
    return {
      kind: 'result',
      end: failed ? 'failed' : options.interactive ? 'turn' : 'completed',
      ...(sessionId === undefined ? {} : { sessionId }),
      usage,
      ...(failed ? { error: reason } : {}),
    };
  }

  return {
    translate(message) {
      const fields = message as unknown as Record<string, unknown>;
      if (typeof fields.session_id === 'string' && fields.session_id !== '') {
        sessionId = fields.session_id;
      }
      switch (message.type) {
        case 'assistant':
          return assistant(
            message.message.content,
            message.parent_tool_use_id,
            typeof fields.error === 'string' ? fields.error : undefined,
          );
        case 'user':
          return user(message.message.content, message.parent_tool_use_id);
        case 'result':
          return [result(fields)];
        default:
          return [];
      }
    },
    sessionId: () => sessionId,
  };
}
