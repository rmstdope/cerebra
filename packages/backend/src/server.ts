import websocket from '@fastify/websocket';
import Fastify, {
  type FastifyInstance,
  type FastifyListenOptions,
} from 'fastify';
import { createInstanceService, type InstanceService } from './instance.js';

interface ServerOptions {
  readonly instance?: InstanceService;
}

export const createServer = async ({
  instance = createInstanceService(),
}: ServerOptions = {}): Promise<FastifyInstance> => {
  const server = Fastify();

  await server.register(websocket);

  server.get('/health', async () => ({ status: 'ok' }));

  server.get('/api/instance', async () => ({
    status: 'running' as const,
    ...instance.getStatus(),
  }));

  server.post('/api/instance/update', async (_request, reply) => {
    try {
      return await instance.requestUpdate();
    } catch (error) {
      return reply.status(503).send({
        error:
          error instanceof Error ? error.message : 'The local update failed.',
      });
    }
  });

  server.get('/ws', { websocket: true }, (socket) => {
    socket.on('message', (message) => socket.send(message));
  });

  return server;
};

export const startServer = async (
  options: FastifyListenOptions,
  serverOptions?: ServerOptions,
): Promise<FastifyInstance> => {
  const server = await createServer(serverOptions);

  await server.listen(options);

  return server;
};
