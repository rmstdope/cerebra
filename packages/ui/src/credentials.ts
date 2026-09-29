export type CredentialScope = 'instance' | 'project';
export type CredentialDeliveryMethod = 'environment' | 'file';

export interface CredentialRow {
  readonly id: string | null;
  readonly lastUsedAt: string | null;
  readonly lastUsedRunId: string | null;
  readonly name: string;
  readonly needsAttention: boolean;
  readonly scope: CredentialScope;
  readonly usedBy: readonly string[];
  readonly usedByEveryAgent: boolean;
}

export interface CredentialAttention {
  readonly agentTypes: readonly string[];
  readonly everyAgent: boolean;
  readonly name: string;
  readonly scope: CredentialScope | null;
}

export interface CredentialOverview {
  readonly attention: readonly CredentialAttention[];
  readonly instanceCredentials: readonly CredentialRow[];
  readonly project: { readonly id: string; readonly name: string } | null;
  readonly projectCredentials: readonly CredentialRow[];
}

export interface AgentCredentialDelivery {
  readonly credentialName: string;
  readonly delivery: CredentialDeliveryMethod;
  readonly destination: string;
}

export interface AgentCredentialEntry extends AgentCredentialDelivery {
  readonly builtIn: boolean;
  readonly needsAttention: boolean;
}

export interface AgentCredentialSettings {
  readonly agentType: string;
  readonly available: readonly string[];
  readonly entries: readonly AgentCredentialEntry[];
}

export interface SaveCredentialInput {
  readonly name: string;
  readonly projectId?: string;
  readonly scope: CredentialScope;
  readonly value: string;
}

export interface CredentialClient {
  agentCredentials(
    projectId: string,
    agentType: string,
  ): Promise<AgentCredentialSettings>;
  overview(projectId: string | null): Promise<CredentialOverview>;
  remove(id: string): Promise<void>;
  save(
    input: SaveCredentialInput,
  ): Promise<{ readonly name: string; readonly replaced: boolean }>;
  setAgentCredentials(
    projectId: string,
    agentType: string,
    deliveries: readonly AgentCredentialDelivery[],
  ): Promise<AgentCredentialSettings>;
}

export class CredentialRequestError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly destination: string | null,
  ) {
    super(message);
    this.name = 'CredentialRequestError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      code?: string;
      destination?: string;
      error?: string;
    } | null;
    throw new CredentialRequestError(
      body?.error ?? `Request failed with status ${response.status}.`,
      body?.code ?? null,
      body?.destination ?? null,
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

const json = { 'content-type': 'application/json' };

function agentUrl(projectId: string, agentType: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/agent-types/${encodeURIComponent(agentType)}/credentials`;
}

export const browserCredentialClient: CredentialClient = {
  agentCredentials: (projectId, agentType) =>
    request(agentUrl(projectId, agentType)),
  overview: (projectId) =>
    request(
      projectId === null
        ? '/api/credentials'
        : `/api/credentials?projectId=${encodeURIComponent(projectId)}`,
    ),
  remove: (id) =>
    request(`/api/credentials/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  save: (input) =>
    request('/api/credentials', {
      body: JSON.stringify(input),
      headers: json,
      method: 'PUT',
    }),
  setAgentCredentials: (projectId, agentType, deliveries) =>
    request(agentUrl(projectId, agentType), {
      body: JSON.stringify({ deliveries }),
      headers: json,
      method: 'PUT',
    }),
};

const agentTypeNames: Record<string, { one: string; many: string }> = {
  assistant: { many: 'Assistants', one: 'Assistant' },
  bugfixer: { many: 'Bugfixers', one: 'Bugfixer' },
  designer: { many: 'Designers', one: 'Designer' },
  groomer: { many: 'Groomers', one: 'Groomer' },
  producer: { many: 'Producers', one: 'Producer' },
  reviewer: { many: 'Reviewers', one: 'Reviewer' },
};

export function agentTypeName(agentType: string, plural = false): string {
  const known = agentTypeNames[agentType];
  if (known !== undefined) {
    return plural ? known.many : known.one;
  }
  const title = agentType.charAt(0).toUpperCase() + agentType.slice(1);
  return plural ? `${title}s` : title;
}

export function joinWithAnd(parts: readonly string[]): string {
  if (parts.length <= 1) {
    return parts.join('');
  }
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}
