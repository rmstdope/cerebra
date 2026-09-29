export interface ProjectDiscovery {
  readonly defaultBranch: string;
  readonly name: string;
  readonly owner: string;
  readonly prefix: string;
  readonly remote: string;
}

export interface RegisteredProject extends ProjectDiscovery {
  readonly id: string;
}

export interface ProjectClient {
  discover(input: {
    readonly credential: string;
    readonly remote: string;
  }): Promise<ProjectDiscovery>;
  register(input: {
    readonly credential: string;
    readonly prefix: string;
    readonly remote: string;
  }): Promise<RegisteredProject>;
}

async function responseError(response: Response): Promise<Error> {
  const body = (await response.json()) as { error?: string };
  return new Error(body.error ?? 'Cerebra couldn’t add this project');
}

export const browserProjectClient: ProjectClient = {
  async discover(input) {
    const response = await fetch('/api/projects/discover', {
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    if (!response.ok) {
      throw await responseError(response);
    }
    return (await response.json()) as ProjectDiscovery;
  },
  async register(input) {
    const response = await fetch('/api/projects', {
      body: JSON.stringify(input),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    if (!response.ok) {
      throw await responseError(response);
    }
    return (await response.json()) as RegisteredProject;
  },
};
