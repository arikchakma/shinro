import { serve } from '@hono/node-server';

import app from './app.ts';
import { shutdown } from './shutdown.ts';

const server = serve(
  {
    fetch: app.fetch,
    port: Number(process.env.PORT ?? 3000),
  },
  (info) => {
    console.info(`[api] Listening on http://localhost:${info.port}`);
  }
);

process.once('SIGINT', () => {
  void shutdown(server, 'SIGINT');
});

process.once('SIGTERM', () => {
  void shutdown(server, 'SIGTERM');
});
