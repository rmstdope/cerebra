import { startServer } from './server.js';

const port = Number(process.env.CEREBRA_PORT ?? 4317);

await startServer(
  { host: '0.0.0.0', port },
  { uiDirectory: new URL('../../ui/dist', import.meta.url).pathname },
);
