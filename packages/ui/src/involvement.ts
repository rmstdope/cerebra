/** How closely the navigator follows a project's builders (spec §4.9). */
export type Involvement = 'autonomous' | 'plan' | 'full';

export interface InvolvementSetting {
  readonly involvement: Involvement;
  readonly reviewAccount: string | null;
}

export interface InvolvementClient {
  get(projectId: string): Promise<InvolvementSetting>;
  save(
    projectId: string,
    setting: InvolvementSetting,
  ): Promise<InvolvementSetting>;
}

/** A save that failed; `invalid` when the server refused it with words the form shows. */
export class InvolvementRequestError extends Error {
  constructor(
    message: string,
    readonly invalid: boolean,
  ) {
    super(message);
    this.name = 'InvolvementRequestError';
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      code?: string;
      error?: string;
    } | null;
    throw new InvolvementRequestError(
      body?.error ?? `Request failed with status ${response.status}.`,
      body?.code === 'invalid_involvement',
    );
  }
  return (await response.json()) as T;
}

export const browserInvolvementClient: InvolvementClient = {
  get: (projectId) => request(`/api/projects/${projectId}/involvement`),
  save: (projectId, setting) =>
    request(`/api/projects/${projectId}/involvement`, {
      body: JSON.stringify(setting),
      headers: { 'content-type': 'application/json' },
      method: 'PUT',
    }),
};
