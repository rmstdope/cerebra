import websocket from '@fastify/websocket';
import Fastify, {
  type FastifyInstance,
  type FastifyListenOptions,
} from 'fastify';

export const createServer = async (): Promise<FastifyInstance> => {
  const server = Fastify();

  await server.register(websocket);

  server.get('/health', async () => ({ status: 'ok' }));

  server.get('/ws', { websocket: true }, (socket) => {
    socket.on('message', (message) => socket.send(message));
  });

  return server;
};

export const startServer = async (
  options: FastifyListenOptions,
): Promise<FastifyInstance> => {
  const server = await createServer();

  await server.listen(options);

  return server;
};
