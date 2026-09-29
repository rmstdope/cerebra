export type AttentionKind = 'question' | 'trouble' | 'waiting';

export interface AttentionEntry {
  readonly agentName: string | null;
  readonly id: string;
  readonly itemId: string | null;
  readonly kind: AttentionKind;
  readonly projectId: string;
  readonly projectName: string;
  readonly runId: string | null;
  readonly since: string;
  readonly title: string;
}

export interface AttentionClient {
  list(): Promise<readonly AttentionEntry[]>;
}

export const browserAttentionClient: AttentionClient = {
  async list() {
    const response = await fetch('/api/attention');
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}.`);
    }
    return (await response.json()) as readonly AttentionEntry[];
  },
};
