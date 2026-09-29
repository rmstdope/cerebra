export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type BoardRoute = 'grooming_ready' | 'design_ready' | 'build_ready';

export interface WorkItem {
  readonly createdAt: string;
  readonly description: string;
  readonly id: string;
  readonly priority: Priority | null;
  readonly state: string;
  readonly title: string;
  readonly updatedAt: string;
}

export interface HistoryEntry {
  readonly actorRole: string;
  readonly createdAt: string;
  readonly fromState: string;
  readonly reason: string | null;
  readonly toState: string;
}

export interface BoardComment {
  readonly body: string;
  readonly createdAt: string;
  readonly id: number;
}

export interface BoardClient {
  addComment(itemId: string, body: string): Promise<BoardComment>;
  cancel(itemId: string): Promise<WorkItem>;
  create(
    projectId: string,
    input: { description: string; title: string },
  ): Promise<WorkItem>;
  history(itemId: string): Promise<readonly HistoryEntry[]>;
  list(projectId: string): Promise<readonly WorkItem[]>;
  comments(itemId: string): Promise<readonly BoardComment[]>;
  triage(
    itemId: string,
    priority: Priority,
    route: BoardRoute,
  ): Promise<WorkItem>;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      body?.error ?? 'Cerebra couldn’t save your changes. Try again.',
    );
  }
  return (await response.json()) as T;
}

export const browserBoardClient: BoardClient = {
  addComment: (itemId, body) =>
    request(`/api/work-items/${itemId}/comments`, {
      body: JSON.stringify({ body }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }),
  cancel: (itemId) =>
    request(`/api/work-items/${itemId}/cancel`, { method: 'POST' }),
  comments: (itemId) => request(`/api/work-items/${itemId}/comments`),
  create: (projectId, input) =>
    request(`/api/projects/${projectId}/work-items`, {
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }),
  history: (itemId) => request(`/api/work-items/${itemId}/history`),
  list: (projectId) => request(`/api/projects/${projectId}/work-items`),
  triage: (itemId, priority, route) =>
    request(`/api/work-items/${itemId}/triage`, {
      body: JSON.stringify({ priority, to: route }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }),
};
