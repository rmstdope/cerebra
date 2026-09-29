export type WaitingReason =
  | { readonly kind: 'paused' }
  | { readonly kind: 'credential_missing'; readonly service: string }
  | {
      readonly kind: 'project_limit' | 'instance_limit';
      readonly limit: number;
      readonly running: number;
    }
  | { readonly kind: 'no_free_agent'; readonly role: string };

export interface AutomaticStartStatus {
  readonly limit: number;
  readonly paused: boolean;
  readonly running: number;
  readonly waiting: readonly {
    readonly itemId: string;
    readonly reason: WaitingReason;
  }[];
}

export interface Limits {
  readonly instanceLimit: number;
  readonly projectLimit: number | null;
}

export interface AutomaticStartsClient {
  status(projectId: string): Promise<AutomaticStartStatus>;
  setPaused(projectId: string, paused: boolean): Promise<void>;
  limits(projectId: string | null): Promise<Limits>;
  saveProjectLimit(projectId: string, value: number): Promise<Limits>;
  saveInstanceLimit(value: number): Promise<Limits>;
}

export const wholeNumberMessage = 'Enter a whole number of 1 or more.';

export function aboveCeilingMessage(instanceLimit: number): string {
  return `This can't be higher than the Cerebra-wide limit (${instanceLimit}).`;
}

/** A limit as typed, or the words the field shows when it cannot be saved. */
export function parseLimit(text: string): number | { readonly error: string } {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return { error: wholeNumberMessage };
  const value = Number(trimmed);
  return value >= 1 && value <= 2_147_483_647
    ? value
    : { error: wholeNumberMessage };
}

export function reasonText(reason: WaitingReason): string {
  switch (reason.kind) {
    case 'paused':
      return 'Waiting — automatic starts are paused';
    case 'credential_missing':
      return `Can't start — ${reason.service} credential missing`;
    case 'project_limit':
      return `Waiting — project limit reached (${reason.running} of ${reason.limit} running)`;
    case 'instance_limit':
      return `Waiting — Cerebra-wide limit reached (${reason.running} of ${reason.limit} running)`;
    case 'no_free_agent':
      return `Waiting — no ${reason.role} is free`;
  }
}

/** A limit the server refused, with the words the field shows. */
export class LimitRequestError extends Error {
  constructor(
    message: string,
    readonly invalid: boolean,
  ) {
    super(message);
    this.name = 'LimitRequestError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      code?: string;
      error?: string;
    } | null;
    throw new LimitRequestError(
      body?.error ?? `Request failed with status ${response.status}.`,
      body?.code === 'invalid_limit',
    );
  }
  return (await response.json()) as T;
}

const json = { 'content-type': 'application/json' };

export const browserAutomaticStartsClient: AutomaticStartsClient = {
  status: (projectId) => request(`/api/projects/${projectId}/automatic-starts`),
  setPaused: async (projectId, paused) => {
    await request(`/api/projects/${projectId}/automatic-starts`, {
      body: JSON.stringify({ paused }),
      headers: json,
      method: 'PUT',
    });
  },
  limits: (projectId) =>
    request(
      projectId === null
        ? '/api/settings/limits'
        : `/api/projects/${projectId}/limits`,
    ),
  saveProjectLimit: (projectId, projectLimit) =>
    request(`/api/projects/${projectId}/limits`, {
      body: JSON.stringify({ projectLimit }),
      headers: json,
      method: 'PUT',
    }),
  saveInstanceLimit: (instanceLimit) =>
    request('/api/settings/limits', {
      body: JSON.stringify({ instanceLimit }),
      headers: json,
      method: 'PUT',
    }),
};
