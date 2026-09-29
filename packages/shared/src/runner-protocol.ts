/** The WebSocket subprotocol a runner offers and the gateway accepts; nothing else is spoken. */
export const runnerProtocol = 'cerebra-runner.v1';

export type RunnerBackend = 'claude';

export interface McpServer {
  readonly type: 'http';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface StartMessage {
  readonly type: 'start';
  readonly backend: RunnerBackend;
  readonly model: string;
  readonly effort: string;
  readonly instructions: string;
  /** An interactive run waits for the navigator after each turn; any other run ends after its first. */
  readonly interactive: boolean;
  readonly firstMessage: string;
  readonly resumeSessionId: string | null;
  readonly mcpServers: Readonly<Record<string, McpServer>>;
  /** Project skills to copy from the checkout's `.cerebro/skills/` (spec §5.5). */
  readonly skills: readonly string[];
}

/** The most files one `fetch_files` may name, and the most bytes its answer may carry. */
export const maxFetchPaths = 64;
export const maxFetchBytes = 8 * 1024 * 1024;

/** One file of a run's checkout, as the runner read it. */
export interface RunFile {
  /** The path as it was asked for, relative to the checkout. */
  readonly path: string;
  readonly contentType: string;
  /** The bytes, base64-encoded. */
  readonly content: string;
}

/** Question text to the answer; a multi-select answer is its labels joined by ", ". */
export type Answers = Readonly<Record<string, string>>;

export type DownMessage =
  | StartMessage
  | { readonly type: 'user_message'; readonly text: string }
  | {
      readonly type: 'answer';
      readonly questionId: string;
      readonly answers: Answers;
    }
  | { readonly type: 'interrupt' }
  | { readonly type: 'stop' }
  | {
      /** Asks for named files of the checkout; the runner refuses a path outside `/work`. */
      readonly type: 'fetch_files';
      readonly requestId: string;
      readonly paths: readonly string[];
    };

export interface QuestionOption {
  readonly label: string;
  readonly description: string;
}

export interface Question {
  readonly question: string;
  readonly header: string;
  readonly multiSelect: boolean;
  readonly options: readonly QuestionOption[];
}

export interface ModelTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

/** What one turn spent, so the backend can add each result to the run as it arrives. */
export interface Usage {
  readonly costUsd: number;
  readonly models: Readonly<Record<string, ModelTokens>>;
}

export type RunStatus = 'active' | 'awaiting_input';

/** `turn`: an interactive run finished a turn and waits; the others end the run. */
export type ResultEnd = 'turn' | 'completed' | 'stopped' | 'failed';

interface Nested {
  /** The sub-agent call this event happened inside, when it did. */
  readonly parentToolCallId?: string;
}

export type AgentEvent = Nested &
  (
    | { readonly kind: 'message'; readonly text: string }
    | { readonly kind: 'thinking'; readonly text: string }
    | {
        readonly kind: 'tool_call';
        readonly toolCallId: string;
        readonly name: string;
        readonly input: unknown;
      }
    | {
        readonly kind: 'tool_result';
        readonly toolCallId: string;
        readonly content: string;
        readonly isError: boolean;
      }
    | {
        readonly kind: 'subagent_start';
        readonly toolCallId: string;
        readonly subagentType: string;
        readonly description: string;
      }
    | {
        readonly kind: 'subagent_end';
        readonly toolCallId: string;
        readonly isError: boolean;
      }
    | {
        readonly kind: 'question';
        readonly questionId: string;
        readonly questions: readonly Question[];
      }
    | {
        readonly kind: 'answer';
        readonly questionId: string;
        readonly answers: Answers;
      }
    | { readonly kind: 'user_message'; readonly text: string }
    | { readonly kind: 'status'; readonly status: RunStatus }
    | { readonly kind: 'error'; readonly message: string }
    | {
        readonly kind: 'result';
        readonly end: ResultEnd;
        readonly sessionId?: string;
        readonly usage: Usage;
        readonly error?: string;
      }
  );

export type AgentEventKind = AgentEvent['kind'];

/** One ordered, numbered stream the chat replays and the supervisor acts on. */
export interface EventMessage {
  readonly type: 'event';
  readonly seq: number;
  readonly event: AgentEvent;
}

/** The answer to one `fetch_files`: every file asked for, or why none is given. */
export type FilesMessage =
  | {
      readonly type: 'files';
      readonly requestId: string;
      readonly files: readonly RunFile[];
    }
  | {
      readonly type: 'files';
      readonly requestId: string;
      readonly error: string;
    };

/** Everything the runner sends. */
export type UpMessage = EventMessage | FilesMessage;

export class RunnerProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RunnerProtocolError';
  }
}

type Fields = Record<string, unknown>;

function fail(message: string): never {
  throw new RunnerProtocolError(message);
}

function object(value: unknown, name: string): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value as Fields;
}

function text(fields: Fields, key: string, name: string): string {
  const value = fields[key];
  if (typeof value !== 'string') {
    fail(`${name}.${key} must be a string`);
  }
  return value;
}

function flag(fields: Fields, key: string, name: string): boolean {
  const value = fields[key];
  if (typeof value !== 'boolean') {
    fail(`${name}.${key} must be a boolean`);
  }
  return value;
}

function count(fields: Fields, key: string, name: string): number {
  const value = fields[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${name}.${key} must be a non-negative number`);
  }
  return value;
}

function textMap(value: unknown, name: string): Record<string, string> {
  const fields = object(value, name);
  for (const entry of Object.values(fields)) {
    if (typeof entry !== 'string') {
      fail(`${name} must map text to text`);
    }
  }
  return fields as Record<string, string>;
}

function textList(value: unknown, name: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    fail(`${name} must be a list of text`);
  }
  return value as string[];
}

function parseJson(raw: string): Fields {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail('Message is not JSON');
  }
  return object(value, 'message');
}

function mcpServers(value: unknown): Record<string, McpServer> {
  const fields = object(value, 'start.mcpServers');
  const servers: Record<string, McpServer> = {};
  for (const [name, entry] of Object.entries(fields)) {
    const label = `start.mcpServers.${name}`;
    const server = object(entry, label);
    if (server.type !== 'http') {
      fail(`${label}.type must be http`);
    }
    servers[name] = {
      type: 'http',
      url: text(server, 'url', label),
      headers: textMap(server.headers, `${label}.headers`),
    };
  }
  return servers;
}

function parseStart(fields: Fields): StartMessage {
  const backend = text(fields, 'backend', 'start');
  if (backend !== 'claude') {
    fail(`Unsupported backend: ${backend}`);
  }
  const resume = fields.resumeSessionId;
  if (resume !== null && typeof resume !== 'string') {
    fail('start.resumeSessionId must be a string or null');
  }
  return {
    type: 'start',
    backend,
    model: text(fields, 'model', 'start'),
    effort: text(fields, 'effort', 'start'),
    instructions: text(fields, 'instructions', 'start'),
    interactive: flag(fields, 'interactive', 'start'),
    firstMessage: text(fields, 'firstMessage', 'start'),
    resumeSessionId: resume,
    mcpServers: mcpServers(fields.mcpServers),
    skills: textList(fields.skills, 'start.skills'),
  };
}

export function parseDownMessage(raw: string): DownMessage {
  const fields = parseJson(raw);
  switch (fields.type) {
    case 'start':
      return parseStart(fields);
    case 'user_message':
      return {
        type: 'user_message',
        text: text(fields, 'text', 'user_message'),
      };
    case 'answer':
      return {
        type: 'answer',
        questionId: text(fields, 'questionId', 'answer'),
        answers: textMap(fields.answers, 'answer.answers'),
      };
    case 'interrupt':
    case 'stop':
      return { type: fields.type };
    case 'fetch_files': {
      const paths = textList(fields.paths, 'fetch_files.paths');
      if (paths.length < 1 || paths.length > maxFetchPaths) {
        fail(
          `fetch_files.paths must name between 1 and ${maxFetchPaths} files`,
        );
      }
      return {
        type: 'fetch_files',
        requestId: text(fields, 'requestId', 'fetch_files'),
        paths,
      };
    }
    default:
      return fail(`Unknown message type: ${String(fields.type)}`);
  }
}

function questions(value: unknown): Question[] {
  if (!Array.isArray(value)) {
    fail('question.questions must be a list');
  }
  return value.map((entry, index) => {
    const label = `question.questions.${index}`;
    const fields = object(entry, label);
    if (!Array.isArray(fields.options)) {
      fail(`${label}.options must be a list`);
    }
    return {
      question: text(fields, 'question', label),
      header: text(fields, 'header', label),
      multiSelect: flag(fields, 'multiSelect', label),
      options: fields.options.map((option, optionIndex) => {
        const optionLabel = `${label}.options.${optionIndex}`;
        const optionFields = object(option, optionLabel);
        return {
          label: text(optionFields, 'label', optionLabel),
          description: text(optionFields, 'description', optionLabel),
        };
      }),
    };
  });
}

function usage(value: unknown): Usage {
  const fields = object(value, 'result.usage');
  const models: Record<string, ModelTokens> = {};
  for (const [model, entry] of Object.entries(
    object(fields.models, 'result.usage.models'),
  )) {
    const label = `result.usage.models.${model}`;
    const tokens = object(entry, label);
    models[model] = {
      inputTokens: count(tokens, 'inputTokens', label),
      outputTokens: count(tokens, 'outputTokens', label),
      cacheReadInputTokens: count(tokens, 'cacheReadInputTokens', label),
      cacheCreationInputTokens: count(
        tokens,
        'cacheCreationInputTokens',
        label,
      ),
    };
  }
  return { costUsd: count(fields, 'costUsd', 'result.usage'), models };
}

const resultEnds: readonly ResultEnd[] = [
  'turn',
  'completed',
  'stopped',
  'failed',
];

function optionalText(
  fields: Fields,
  key: string,
  name: string,
): string | undefined {
  return fields[key] === undefined ? undefined : text(fields, key, name);
}

function eventBody(fields: Fields): AgentEvent {
  switch (fields.kind) {
    case 'message':
    case 'thinking':
      return { kind: fields.kind, text: text(fields, 'text', fields.kind) };
    case 'tool_call':
      return {
        kind: 'tool_call',
        toolCallId: text(fields, 'toolCallId', 'tool_call'),
        name: text(fields, 'name', 'tool_call'),
        input: fields.input,
      };
    case 'tool_result':
      return {
        kind: 'tool_result',
        toolCallId: text(fields, 'toolCallId', 'tool_result'),
        content: text(fields, 'content', 'tool_result'),
        isError: flag(fields, 'isError', 'tool_result'),
      };
    case 'subagent_start':
      return {
        kind: 'subagent_start',
        toolCallId: text(fields, 'toolCallId', 'subagent_start'),
        subagentType: text(fields, 'subagentType', 'subagent_start'),
        description: text(fields, 'description', 'subagent_start'),
      };
    case 'subagent_end':
      return {
        kind: 'subagent_end',
        toolCallId: text(fields, 'toolCallId', 'subagent_end'),
        isError: flag(fields, 'isError', 'subagent_end'),
      };
    case 'question':
      return {
        kind: 'question',
        questionId: text(fields, 'questionId', 'question'),
        questions: questions(fields.questions),
      };
    case 'answer':
      return {
        kind: 'answer',
        questionId: text(fields, 'questionId', 'answer'),
        answers: textMap(fields.answers, 'answer.answers'),
      };
    case 'user_message':
      return {
        kind: 'user_message',
        text: text(fields, 'text', 'user_message'),
      };
    case 'status':
      if (fields.status !== 'active' && fields.status !== 'awaiting_input') {
        fail('status.status must be active or awaiting_input');
      }
      return { kind: 'status', status: fields.status };
    case 'error':
      return { kind: 'error', message: text(fields, 'message', 'error') };
    case 'result': {
      const end = fields.end;
      if (!resultEnds.includes(end as ResultEnd)) {
        fail(`result.end must be one of ${resultEnds.join(', ')}`);
      }
      const sessionId = optionalText(fields, 'sessionId', 'result');
      const error = optionalText(fields, 'error', 'result');
      return {
        kind: 'result',
        end: end as ResultEnd,
        ...(sessionId === undefined ? {} : { sessionId }),
        usage: usage(fields.usage),
        ...(error === undefined ? {} : { error }),
      };
    }
    default:
      return fail(`Unknown event kind: ${String(fields.kind)}`);
  }
}

function parseEvent(value: unknown): AgentEvent {
  const fields = object(value, 'event.event');
  const event = eventBody(fields);
  const parent = optionalText(
    fields,
    'parentToolCallId',
    fields.kind as string,
  );
  return parent === undefined ? event : { ...event, parentToolCallId: parent };
}

const base64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function parseFiles(fields: Fields): FilesMessage {
  const requestId = text(fields, 'requestId', 'files');
  if (fields.error !== undefined) {
    return { type: 'files', requestId, error: text(fields, 'error', 'files') };
  }
  if (!Array.isArray(fields.files)) {
    fail('files.files must be a list');
  }
  return {
    type: 'files',
    requestId,
    files: fields.files.map((entry, index) => {
      const label = `files.files.${index}`;
      const file = object(entry, label);
      const content = text(file, 'content', label);
      if (!base64.test(content)) {
        fail(`${label}.content must be base64`);
      }
      return {
        path: text(file, 'path', label),
        contentType: text(file, 'contentType', label),
        content,
      };
    }),
  };
}

export function parseUpMessage(raw: string): UpMessage {
  const fields = parseJson(raw);
  if (fields.type === 'files') {
    return parseFiles(fields);
  }
  if (fields.type !== 'event') {
    fail(`Unknown message type: ${String(fields.type)}`);
  }
  const seq = fields.seq;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
    fail('event.seq must be a positive integer');
  }
  return { type: 'event', seq, event: parseEvent(fields.event) };
}
