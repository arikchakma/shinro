import { serve } from '@hono/node-server';

import app from './app.ts';

// Shinro never touches this file. Run it however you like:
//
//   tsx watch src/server.ts
//   bun --watch src/server.ts
//   node --watch --experimental-strip-types src/server.ts
//   node dist/server.mjs          (after `tsdown`)
const server = serve(
  {
    fetch: app.fetch,
    port: Number(process.env.PORT ?? 3000),
  },
  (info) => {
    console.info(`[api] Listening on http://localhost:${info.port}`);
  }
);

const shutdown = (signal: NodeJS.Signals) => {
  console.info(`[api] ${signal} received, draining`);
  server.close(() => process.exit(0));
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
