export type AgentRole =
  'assistant' | 'groomer' | 'designer' | 'producer' | 'bugfixer' | 'reviewer';
export type AgentModel = 'opus' | 'sonnet' | 'haiku';
export type StartMode = 'ready' | 'manual';

export const modelOptions: readonly {
  readonly id: AgentModel;
  readonly label: string;
}[] = [
  { id: 'opus', label: 'Claude Opus' },
  { id: 'sonnet', label: 'Claude Sonnet' },
  { id: 'haiku', label: 'Claude Haiku' },
];

export interface FleetItem {
  readonly id: string;
  readonly title: string;
}

export type AgentActivity =
  | { readonly kind: 'available' }
  | { readonly item: FleetItem; readonly kind: 'working' }
  | {
      readonly item: FleetItem;
      readonly kind: 'waiting';
      readonly question: string;
    };

export interface FleetPerson {
  readonly activity: AgentActivity;
  readonly enabled: boolean;
  readonly id: string;
  readonly name: string;
  readonly role: AgentRole;
  /** True while the person has a live run, whether or not it holds work. */
  readonly running: boolean;
  readonly typeId: string;
}

export interface FleetRole {
  readonly interactive: boolean;
  readonly model: AgentModel;
  readonly people: readonly string[];
  readonly role: AgentRole;
  readonly startMode: StartMode | null;
  readonly typeId: string;
}

export interface FleetView {
  readonly people: readonly FleetPerson[];
  readonly project: {
    readonly id: string;
    readonly name: string;
    readonly owner: string;
  };
  readonly roles: readonly FleetRole[];
}

export interface RoleSettings {
  readonly model: AgentModel;
  readonly startMode: StartMode | null;
}

export interface FleetClient {
  addPerson(
    projectId: string,
    input: { readonly name: string; readonly typeId: string },
  ): Promise<FleetPerson>;
  read(projectId: string): Promise<FleetView>;
  removePerson(agentId: string): Promise<void>;
  saveRoleSettings(
    projectId: string,
    typeId: string,
    settings: RoleSettings,
  ): Promise<FleetRole>;
  start(agentId: string): Promise<void>;
  stop(agentId: string): Promise<void>;
  updatePerson(
    agentId: string,
    changes: { readonly enabled?: boolean; readonly name?: string },
  ): Promise<FleetPerson>;
}

export class FleetRequestError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'FleetRequestError';
  }
}

async function send(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      code?: string;
      error?: string;
    } | null;
    throw new FleetRequestError(
      body?.error ?? `Request failed with status ${response.status}.`,
      body?.code ?? null,
    );
  }
  return response;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  return (await (await send(url, init)).json()) as T;
}

function jsonBody(method: string, body: unknown): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method,
  };
}

export const browserFleetClient: FleetClient = {
  addPerson: (projectId, input) =>
    request(`/api/projects/${projectId}/agents`, jsonBody('POST', input)),
  read: (projectId) => request(`/api/projects/${projectId}/fleet`),
  removePerson: async (agentId) => {
    await send(`/api/agents/${agentId}`, { method: 'DELETE' });
  },
  saveRoleSettings: (projectId, typeId, settings) =>
    request(
      `/api/projects/${projectId}/roles/${typeId}`,
      jsonBody('PUT', settings),
    ),
  start: async (agentId) => {
    await send(`/api/agents/${agentId}/start`, { method: 'POST' });
  },
  stop: async (agentId) => {
    await send(`/api/agents/${agentId}/stop`, { method: 'POST' });
  },
  updatePerson: (agentId, changes) =>
    request(`/api/agents/${agentId}`, jsonBody('PATCH', changes)),
};
