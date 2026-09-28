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

export const browserInstanceClient: InstanceClient = {
  async getStatus() {
    const response = await fetch('/api/instance');
    if (!response.ok) {
      throw new Error('Cerebra isn’t running');
    }
    return (await response.json()) as InstanceStatus;
  },
  async update() {
    const response = await fetch('/api/instance/update', { method: 'POST' });
    if (!response.ok) {
      const body = (await response.json()) as { error?: string };
      throw new Error(body.error ?? 'Cerebra couldn’t restart');
    }
  },
};
