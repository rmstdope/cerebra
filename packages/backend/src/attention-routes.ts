import type { FastifyInstance, FastifyReply } from 'fastify';

import { ProjectNotFoundError, WorkItemNotFoundError } from './board.js';
import type { Attention } from './attention.js';
import type { CostReader, RunCost } from './costs.js';
import type { NotificationSettings } from './notification-settings.js';
import type { Notifier } from './notifier.js';

export interface AttentionRouteOptions {
  readonly attention?: Attention;
  readonly costs?: CostReader;
  readonly notificationSettings?: NotificationSettings;
  readonly notifications?: Pick<Notifier, 'connect'>;
}

function runCostBody<T extends RunCost>(run: T) {
  return { ...run, startedAt: run.startedAt.toISOString() };
}

/** The run a `{ type: 'focus' }` message names; undefined for anything else. */
function focusedRun(text: string): string | null | undefined {
  try {
    const message = JSON.parse(text) as { runId?: unknown; type?: unknown };
    if (
      message.type === 'focus' &&
      (message.runId === null || typeof message.runId === 'string')
    ) {
      return message.runId;
    }
  } catch {
    // Not a message the tab should send; it is ignored.
  }
  return undefined;
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
  {
    attention,
    costs,
    notificationSettings,
    notifications,
  }: AttentionRouteOptions,
): void {
  server.get('/api/attention', async (request, reply) => {
    try {
      if (attention === undefined) throw new Error('No attention list.');
      return await attention.list();
    } catch {
      request.log.error('Could not read what needs the navigator.');
      return reply
        .status(503)
        .send({ error: 'We couldn’t load what needs your attention.' });
    }
  });

  server.get('/api/notification-settings', async (_request, reply) => {
    if (notificationSettings === undefined) {
      return reply
        .status(503)
        .send({ error: 'Notification settings are unavailable.' });
    }
    return notificationSettings.list();
  });

  server.put(
    '/api/projects/:projectId/notification-settings',
    async (request, reply) => {
      if (notificationSettings === undefined) {
        return reply
          .status(503)
          .send({ error: 'Notification settings are unavailable.' });
      }
      const { projectId } = request.params as { projectId: string };
      const body = request.body as { browserNotifications?: unknown } | null;
      if (typeof body?.browserNotifications !== 'boolean') {
        return reply
          .status(400)
          .send({ error: 'Say whether browser notifications are on.' });
      }
      try {
        await notificationSettings.set(projectId, body.browserNotifications);
      } catch (error) {
        return notFound(reply, error);
      }
      return { browserNotifications: body.browserNotifications, projectId };
    },
  );

  server.get('/ws/notifications', { websocket: true }, (socket) => {
    if (notifications === undefined) {
      socket.close(1011, 'Notifications are unavailable.');
      return;
    }
    const tab = notifications.connect((message) => {
      socket.send(JSON.stringify(message));
    });
    socket.on('message', (data: Buffer) => {
      const runId = focusedRun(data.toString());
      if (runId !== undefined) tab.focus(runId);
    });
    socket.on('close', () => tab.close());
  });

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
