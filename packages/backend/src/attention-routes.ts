import type { FastifyInstance, FastifyReply } from 'fastify';

import { ProjectNotFoundError, WorkItemNotFoundError } from './board.js';
import type { CostReader, RunCost } from './costs.js';

export interface AttentionRouteOptions {
  readonly costs?: CostReader;
}

function runCostBody<T extends RunCost>(run: T) {
  return { ...run, startedAt: run.startedAt.toISOString() };
}

function notFound(reply: FastifyReply, error: unknown): FastifyReply {
  if (
    error instanceof WorkItemNotFoundError ||
    error instanceof ProjectNotFoundError
  ) {
    return reply.status(404).send({ error: error.message });
  }
  throw error;
}

/** Costs, what needs the navigator, and the browser notifications about it (spec §4.8, §10). */
export function registerAttentionRoutes(
  server: FastifyInstance,
  { costs }: AttentionRouteOptions,
): void {
  const costsUnavailable = (reply: FastifyReply) =>
    reply.status(503).send({ error: 'Costs are unavailable.' });

  server.get('/api/work-items/:itemId/cost', async (request, reply) => {
    if (costs === undefined) return costsUnavailable(reply);
    const { itemId } = request.params as { itemId: string };
    try {
      const cost = await costs.forItem(itemId);
      return { ...cost, runs: cost.runs.map(runCostBody) };
    } catch (error) {
      return notFound(reply, error);
    }
  });

  server.get('/api/projects/:projectId/cost', async (request, reply) => {
    if (costs === undefined) return costsUnavailable(reply);
    const { projectId } = request.params as { projectId: string };
    try {
      const cost = await costs.forProject(projectId);
      return { ...cost, runs: cost.runs.map(runCostBody) };
    } catch (error) {
      return notFound(reply, error);
    }
  });
}
