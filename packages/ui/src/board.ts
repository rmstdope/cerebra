export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type BoardRoute = 'grooming_ready' | 'design_ready' | 'build_ready';
export type BoardSort = 'newest' | 'oldest' | 'priority';

export type WorkItemType = 'feature' | 'bug' | 'task' | 'refactoring';

/** The four types in the order the navigator is offered them (spec §4.1). */
export const workItemTypes: readonly WorkItemType[] = [
  'feature',
  'bug',
  'task',
  'refactoring',
];

const typeLabels: Record<WorkItemType, string> = {
  bug: 'Bug',
  feature: 'Feature',
  refactoring: 'Refactoring',
  task: 'Task',
};

export function typeLabel(type: WorkItemType): string {
  return typeLabels[type];
}

export const workItemStates = [
  'new',
  'grooming_ready',
  'grooming',
  'design_ready',
  'designing',
  'build_ready',
  'building',
  'review_ready',
  'reviewing',
  'merging',
  'verify_ready',
  'verifying',
  'waiting',
  'split',
  'done',
  'cancelled',
] as const;

export interface FiledBy {
  readonly agentName: string | null;
  readonly discoveredFrom: {
    readonly id: string;
    readonly title: string;
  } | null;
  readonly role: string;
}

export interface WorkItem {
  readonly createdAt: string;
  readonly description: string;
  /** Present on board list rows; null when the navigator filed the item. */
  readonly filedBy?: FiledBy | null;
  readonly id: string;
  /** The project's prefix and the item's number, `WEB-12` (spec §4.1). */
  readonly key: string;
  readonly priority: Priority | null;
  readonly state: string;
  readonly title: string;
  readonly type: WorkItemType;
  readonly updatedAt: string;
}

export interface HistoryEntry {
  readonly actorRole: string;
  readonly createdAt: string;
  readonly fromState: string;
  /** A state change, or the one entry saying the item was carried over from the old task list. */
  readonly kind?: 'carried_over' | 'transition';
  readonly reason: string | null;
  readonly toState: string;
}

export interface BoardComment {
  readonly body: string;
  readonly createdAt: string;
  readonly id: number | string;
}

export interface BoardFilters {
  readonly priority: string;
  readonly search: string;
  readonly sort: BoardSort;
  readonly state: string;
}

export interface BoardPage {
  readonly items: readonly WorkItem[];
  readonly nextCursor: string | null;
  readonly snapshot: string;
  readonly total: number;
}

export interface BoardClient {
  addComment(itemId: string, body: string): Promise<BoardComment>;
  arrivals(
    projectId: string,
    filters: BoardFilters,
    snapshot: string,
  ): Promise<number>;
  cancel(itemId: string): Promise<WorkItem>;
  comments(itemId: string): Promise<readonly BoardComment[]>;
  create(
    projectId: string,
    input: { description: string; title: string; type: WorkItemType },
  ): Promise<WorkItem>;
  history(itemId: string): Promise<readonly HistoryEntry[]>;
  item(itemId: string): Promise<WorkItem>;
  list(
    projectId: string,
    filters: BoardFilters,
    page?: { readonly cursor: string; readonly snapshot: string },
  ): Promise<BoardPage>;
  triage(
    itemId: string,
    priority: Priority,
    route: BoardRoute,
  ): Promise<WorkItem>;
}

export class BoardRequestError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'BoardRequestError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
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
  return (await response.json()) as T;
}

function queryString(values: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') {
      query.set(key, value);
    }
  }
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}

function filterQuery(filters: BoardFilters): Record<string, string> {
  return {
    priority: filters.priority,
    search: filters.search.trim(),
    sort: filters.sort,
    state: filters.state,
  };
}

const json = { 'content-type': 'application/json' };

export const browserBoardClient: BoardClient = {
  addComment: (itemId, body) =>
    request(`/api/work-items/${itemId}/comments`, {
      body: JSON.stringify({ body }),
      headers: json,
      method: 'POST',
    }),
  arrivals: (projectId, filters, snapshot) =>
    request<{ count: number }>(
      `/api/projects/${projectId}/work-items/arrivals${queryString({
        ...filterQuery(filters),
        snapshot,
      })}`,
    ).then((body) => body.count),
  cancel: (itemId) =>
    request(`/api/work-items/${itemId}/cancel`, { method: 'POST' }),
  comments: (itemId) => request(`/api/work-items/${itemId}/comments`),
  create: (projectId, input) =>
    request(`/api/projects/${projectId}/work-items`, {
      body: JSON.stringify(input),
      headers: json,
      method: 'POST',
    }),
  history: (itemId) => request(`/api/work-items/${itemId}/history`),
  item: (itemId) => request(`/api/work-items/${itemId}`),
  list: (projectId, filters, page) =>
    request(
      `/api/projects/${projectId}/work-items${queryString({
        ...filterQuery(filters),
        cursor: page?.cursor,
        snapshot: page?.snapshot,
      })}`,
    ),
  triage: (itemId, priority, route) =>
    request(`/api/work-items/${itemId}/triage`, {
      body: JSON.stringify({ priority, to: route }),
      headers: json,
      method: 'POST',
    }),
};
