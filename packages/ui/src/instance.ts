export interface InstanceStatus {
  readonly address: string;
  readonly lastUpdatedAt: string;
  readonly status: 'running';
  readonly version: string;
}

export interface InstanceClient {
  getStatus(): Promise<InstanceStatus>;
  update(): Promise<void>;
}

export class AuthenticationRequiredError extends Error {
  public constructor(public readonly reason: 'expired' | 'signed-out') {
    super('Sign in to continue.');
  }
}

export const browserInstanceClient: InstanceClient = {
  async getStatus() {
    const response = await fetch('/api/instance');
    if (!response.ok) {
      await throwAuthenticationRequired(response);
      throw new Error('Cerebra isn’t running');
    }
    return (await response.json()) as InstanceStatus;
  },
  async update() {
    const response = await fetch('/api/instance/update', { method: 'POST' });
    if (!response.ok) {
      await throwAuthenticationRequired(response);
      const body = (await response.json()) as { error?: string };
      throw new Error(body.error ?? 'Cerebra couldn’t restart');
    }
  },
};

async function throwAuthenticationRequired(response: Response): Promise<void> {
  if (response.status !== 401) {
    return;
  }

  const body = (await response.json()) as { reason?: string };
  if (body.reason === 'expired' || body.reason === 'signed-out') {
    throw new AuthenticationRequiredError(body.reason);
  }
}
