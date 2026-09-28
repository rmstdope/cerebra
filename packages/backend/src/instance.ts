export interface InstanceStatus {
  readonly address: string;
  readonly lastUpdatedAt: string;
  readonly version: string;
}

export interface InstanceService {
  getStatus(): InstanceStatus;
  requestUpdate(): Promise<{ ok: true }>;
}

export function createInstanceService(
  environment: NodeJS.ProcessEnv = process.env,
): InstanceService {
  const status: InstanceStatus = {
    address: environment.CEREBRA_ADDRESS ?? 'http://localhost:4317',
    lastUpdatedAt: environment.CEREBRA_UPDATED_AT ?? new Date().toISOString(),
    version: environment.CEREBRA_VERSION ?? '0.0.0',
  };

  return {
    getStatus: () => status,
    async requestUpdate() {
      throw new Error(
        'The local update command is unavailable. Run ./cerebra update from the Cerebra folder.',
      );
    },
  };
}
