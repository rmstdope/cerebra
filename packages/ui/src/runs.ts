export type RunState =
  'starting' | 'active' | 'awaiting_input' | 'finished' | 'failed';

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

/** The runner's events as the backend records them; kinds the page does not show pass through. */
export type RunEvent = { readonly parentToolCallId?: string } & (
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'user_message'; readonly text: string }
  | { readonly kind: 'tool_call'; readonly name: string }
  | {
      readonly kind: 'question';
      readonly questionId: string;
      readonly questions: readonly Question[];
    }
  | {
      readonly kind: 'answer';
      readonly questionId: string;
      readonly answers: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'status'; readonly status: 'active' | 'awaiting_input' }
  | {
      readonly kind:
        | 'thinking'
        | 'tool_result'
        | 'subagent_start'
        | 'subagent_end'
        | 'error'
        | 'result';
    }
);

export interface RecordedEvent {
  readonly createdAt: string;
  readonly event: RunEvent;
  readonly position: number;
}

export interface ConversationRun {
  readonly agentId: string | null;
  readonly agentName: string | null;
  readonly agentRole: string | null;
  readonly endedAt: string | null;
  readonly failure: string | null;
  readonly id: string;
  readonly item: { readonly id: string; readonly title: string } | null;
  readonly startedAt: string;
  readonly state: RunState;
}

export interface Conversation {
  readonly events: readonly RecordedEvent[];
  readonly run: ConversationRun;
}

export type RunUpdate =
  | ({ readonly type: 'event' } & RecordedEvent)
  | {
      readonly type: 'state';
      readonly state: RunState;
      readonly failure: string | null;
    };

export interface ConversationClient {
  read(runId: string): Promise<Conversation>;
  send(runId: string, text: string): Promise<void>;
  answer(
    runId: string,
    questionId: string,
    answers: Readonly<Record<string, string>>,
  ): Promise<void>;
  stop(runId: string): Promise<void>;
  /** Streams what happens after `after`; answers a function that stops listening. */
  subscribe(
    runId: string,
    after: number,
    listener: (update: RunUpdate) => void,
  ): () => void;
}

export class ConversationRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ConversationRequestError';
  }
}

async function send(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new ConversationRequestError(
      body?.error ?? `Request failed with status ${response.status}.`,
      response.status,
    );
  }
  return response;
}

function post(url: string, body?: unknown): Promise<Response> {
  return send(
    url,
    body === undefined
      ? { method: 'POST' }
      : {
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        },
  );
}

export const browserConversationClient: ConversationClient = {
  read: async (runId) =>
    (await (await send(`/api/runs/${runId}`)).json()) as Conversation,
  send: async (runId, text) => {
    await post(`/api/runs/${runId}/messages`, { text });
  },
  answer: async (runId, questionId, answers) => {
    await post(`/api/runs/${runId}/answers`, { answers, questionId });
  },
  stop: async (runId) => {
    await post(`/api/runs/${runId}/stop`);
  },
  subscribe(runId, after, listener) {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(
      `${protocol}://${window.location.host}/ws/runs/${runId}?after=${after}`,
    );
    socket.addEventListener('message', (message: MessageEvent<string>) => {
      try {
        listener(JSON.parse(message.data) as RunUpdate);
      } catch {
        // A frame that is not an update is not shown.
      }
    });
    return () => socket.close();
  },
};
