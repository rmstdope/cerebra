import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyInstance,
  type FastifyListenOptions,
} from 'fastify';
import { join } from 'node:path';
import { createInstanceService, type InstanceService } from './instance.js';

interface ServerOptions {
  readonly instance?: InstanceService;
  readonly uiDirectory?: string;
}

export const createServer = async ({
  instance = createInstanceService(),
  uiDirectory = process.env.CEREBRA_UI_DIR,
}: ServerOptions = {}): Promise<FastifyInstance> => {
  const server = Fastify();

  await server.register(websocket);
  if (uiDirectory !== undefined) {
    await server.register(fastifyStatic, { root: join(uiDirectory) });
  }

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

  if (uiDirectory !== undefined) {
    server.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: 'Not found.' });
    });
  }

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
