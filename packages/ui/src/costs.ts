export interface RunCost {
  readonly agentName: string | null;
  readonly costUsd: number;
  readonly id: string;
  readonly role: string;
  readonly startedAt: string;
  readonly state: string;
}

export interface ItemCost {
  readonly runs: readonly RunCost[];
  readonly totalUsd: number;
}

export interface ProjectCost {
  readonly notLinkedUsd: number;
  readonly runs: readonly (RunCost & {
    readonly item: { readonly id: string; readonly title: string } | null;
  })[];
  readonly totalUsd: number;
  readonly workItemsUsd: number;
}

export interface CostClient {
  forItem(itemId: string): Promise<ItemCost>;
  forProject(projectId: string): Promise<ProjectCost>;
}

const usd = new Intl.NumberFormat('en-US', {
  currency: 'USD',
  style: 'currency',
});

/** Full currency with separators and cents, such as $1,234.56. */
export function formatUsd(amount: number): string {
  return usd.format(amount);
}

async function read(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}.`);
  }
  return response.json();
}

export const browserCostClient: CostClient = {
  async forItem(itemId) {
    return (await read(
      `/api/work-items/${encodeURIComponent(itemId)}/cost`,
    )) as ItemCost;
  },
  async forProject(projectId) {
    return (await read(
      `/api/projects/${encodeURIComponent(projectId)}/cost`,
    )) as ProjectCost;
  },
};
