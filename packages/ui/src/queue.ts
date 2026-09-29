import { BoardRequestError, type BoardRoute, type Priority } from './board';

export type QueueEntryKind = 'attention' | 'new' | 'question' | 'review';

export interface QueueEntry {
  readonly askedBy: string | null;
  readonly availableRoutes: readonly BoardRoute[];
  readonly description: string;
  readonly id: string;
  readonly kind: QueueEntryKind;
  readonly priority: Priority | null;
  readonly projectId: string;
  readonly projectName: string;
  /** The live run whose question this is; null for a work item. */
  readonly run: { readonly id: string } | null;
  readonly since: string;
  readonly title: string;
  readonly waitingReason: string | null;
}

export interface QueuePage {
  readonly entries: readonly QueueEntry[];
  readonly total: number;
}

export type QueueDecision =
  | { readonly direction: 'reopen' }
  | { readonly direction: 'cancel'; readonly reason: string }
  | {
      readonly direction: 'redirect';
      readonly priority?: Priority;
      readonly reason: string;
      readonly to: BoardRoute;
    };

export interface QueueClient {
  answer(itemId: string, answer: string): Promise<void>;
  decide(itemId: string, decision: QueueDecision): Promise<void>;
  list(): Promise<QueuePage>;
}

async function request(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      code?: string;
      error?: string;
    } | null;
    throw new BoardRequestError(
      body?.error ?? `Request failed with status ${response.status}.`,
      body?.code ?? null,
    );
  }
  return response.json();
}

function post(url: string, body: unknown): Promise<unknown> {
  return request(url, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
}

export const browserQueueClient: QueueClient = {
  async answer(itemId, answer) {
    await post(`/api/navigator-queue/${encodeURIComponent(itemId)}/answer`, {
      answer,
    });
  },
  async decide(itemId, decision) {
    await post(
      `/api/navigator-queue/${encodeURIComponent(itemId)}/decision`,
      decision,
    );
  },
  async list() {
    return (await request('/api/navigator-queue')) as QueuePage;
  },
};
