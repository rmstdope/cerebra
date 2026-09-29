import type {
  CanUseTool,
  EffortLevel,
  Options,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentEvent,
  Answers,
  Question,
  ResultEnd,
  RunStatus,
  StartMessage,
} from '@cerebra/shared';

import { createClaudeNormalizer } from './claude-normalizer.js';
import { createInputQueue } from './input-queue.js';

/** The SDK's `query`, narrowed to what a run uses, so tests can replay recordings through it. */
export type ClaudeQuery = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncIterable<SDKMessage> & {
  interrupt(): Promise<void>;
  close(): void;
};

export interface ClaudeRun {
  /** A navigator message; mid-turn it reaches the live query, between turns it starts the next. */
  send(text: string): void;
  answer(questionId: string, answers: Answers): void;
  /** Ends the current turn; the run carries on and waits for the navigator. */
  interrupt(): Promise<void>;
  /** Ends the run: stopped, or failed when given the reason it cannot go on. */
  stop(failure?: string): void;
  /** How the run ended, once its final result has been emitted. */
  readonly done: Promise<ResultEnd>;
}

const efforts: readonly EffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

/** Any of these would put Claude in bare or API-key mode, or hand it the runner's own credential. */
const withheld = [
  'CLAUDE_CODE_SIMPLE',
  'ANTHROPIC_API_KEY',
  'CEREBRA_RUN_TOKEN',
];

export function claudeEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !withheld.includes(name)),
  );
}

export function claudeQueryOptions(
  start: StartMessage,
  context: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly canUseTool: CanUseTool;
    readonly cwd?: string;
  },
): Options {
  if (!efforts.includes(start.effort as EffortLevel)) {
    throw new Error(`Unsupported effort: ${start.effort}`);
  }
  return {
    cwd: context.cwd ?? '/work',
    model: start.model,
    effort: start.effort as EffortLevel,
    // Default mode, never bare: bare mode ignores the subscription login (decision D20).
    permissionMode: 'default',
    canUseTool: context.canUseTool,
    settingSources: ['user', 'project', 'local'],
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: start.instructions,
    },
    mcpServers: Object.fromEntries(
      Object.entries(start.mcpServers).map(([name, server]) => [
        name,
        { type: 'http', url: server.url, headers: { ...server.headers } },
      ]),
    ),
    // The SDK replaces the child's environment with this one rather than adding to it.
    env: claudeEnvironment(context.env),
    ...(start.resumeSessionId === null
      ? {}
      : { resume: start.resumeSessionId }),
  };
}

interface AskedQuestion {
  readonly question?: unknown;
  readonly header?: unknown;
  readonly multiSelect?: unknown;
  readonly options?: unknown;
}

function questionsOf(input: Record<string, unknown>): Question[] {
  const asked = Array.isArray(input.questions)
    ? (input.questions as AskedQuestion[])
    : [];
  return asked.map((entry) => ({
    question: String(entry.question ?? ''),
    header: String(entry.header ?? ''),
    multiSelect: entry.multiSelect === true,
    options: (Array.isArray(entry.options)
      ? (entry.options as { label?: unknown; description?: unknown }[])
      : []
    ).map((option) => ({
      label: String(option.label ?? ''),
      description: String(option.description ?? ''),
    })),
  }));
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  };
}

const nothingSpent = { costUsd: 0, models: {} };

export function runClaude(context: {
  readonly start: StartMessage;
  readonly query: ClaudeQuery;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly emit: (event: AgentEvent) => void;
  readonly cwd?: string;
}): ClaudeRun {
  const { start, emit } = context;
  const normalizer = createClaudeNormalizer({ interactive: start.interactive });
  const prompt = createInputQueue<SDKUserMessage>();
  const questions = new Map<string, (answers: Answers | undefined) => void>();
  let status: RunStatus | undefined;
  let finished = false;
  let stopping = false;
  let failure: string | undefined;
  let interrupting = false;

  function become(next: RunStatus): void {
    if (status !== next) {
      status = next;
      emit({ kind: 'status', status: next });
    }
  }

  function say(text: string): void {
    emit({ kind: 'user_message', text });
    become('active');
    prompt.push(userMessage(text));
  }

  const canUseTool: CanUseTool = async (
    toolName,
    input,
    { signal, toolUseID },
  ) => {
    if (toolName !== 'AskUserQuestion') {
      // The container is the boundary; inside it every tool is allowed (architecture §5.1).
      return { behavior: 'allow', updatedInput: input };
    }
    const answers = await new Promise<Answers | undefined>((resolve) => {
      questions.set(toolUseID, resolve);
      signal.addEventListener('abort', () => resolve(undefined), {
        once: true,
      });
      emit({
        kind: 'question',
        questionId: toolUseID,
        questions: questionsOf(input),
      });
      become('awaiting_input');
    });
    questions.delete(toolUseID);
    if (answers === undefined) {
      return {
        behavior: 'deny',
        message: 'The question was withdrawn',
      } satisfies PermissionResult;
    }
    return { behavior: 'allow', updatedInput: { ...input, answers } };
  };

  const query = context.query({
    prompt,
    options: claudeQueryOptions(start, {
      env: context.env,
      canUseTool,
      ...(context.cwd === undefined ? {} : { cwd: context.cwd }),
    }),
  });

  function finish(event: Extract<AgentEvent, { kind: 'result' }>): ResultEnd {
    finished = true;
    prompt.close();
    emit(event);
    return event.end;
  }

  function ending(end: ResultEnd, error?: string): ResultEnd {
    const sessionId = normalizer.sessionId();
    return finish({
      kind: 'result',
      end,
      ...(sessionId === undefined ? {} : { sessionId }),
      usage: nothingSpent,
      ...(error === undefined ? {} : { error }),
    });
  }

  async function drive(): Promise<ResultEnd> {
    say(start.firstMessage);
    try {
      for await (const message of query) {
        if (stopping) {
          break;
        }
        for (const event of normalizer.translate(message)) {
          if (event.kind !== 'result') {
            become('active');
            emit(event);
            continue;
          }
          const interrupted = interrupting;
          interrupting = false;
          if (interrupted && event.end === 'failed') {
            // An interrupted turn reports an execution error; the run itself is fine.
            const turn = { ...event };
            delete turn.error;
            if (!start.interactive) {
              return finish({ ...turn, end: 'stopped' });
            }
            emit({ ...turn, end: 'turn' });
            become('awaiting_input');
          } else if (event.end === 'turn') {
            emit(event);
            become('awaiting_input');
          } else {
            return finish(event);
          }
        }
      }
    } catch (error) {
      if (!stopping) {
        return ending(
          'failed',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (stopping) {
      return failure === undefined
        ? ending('stopped')
        : ending('failed', failure);
    }
    return ending('failed', 'Claude ended before the run finished');
  }

  const done = drive();

  return {
    send(text) {
      if (finished || stopping) {
        throw new Error('The run has ended');
      }
      say(text);
    },
    answer(questionId, answers) {
      const resolve = questions.get(questionId);
      if (resolve === undefined) {
        throw new Error(`No question is waiting with id ${questionId}`);
      }
      questions.delete(questionId);
      emit({ kind: 'answer', questionId, answers });
      become('active');
      resolve(answers);
    },
    async interrupt() {
      interrupting = true;
      await query.interrupt();
    },
    stop(reason) {
      if (finished || stopping) {
        return;
      }
      stopping = true;
      failure = reason;
      for (const resolve of questions.values()) {
        resolve(undefined);
      }
      questions.clear();
      prompt.close();
      query.close();
    },
    done,
  };
}
