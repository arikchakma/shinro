import { serve } from '@hono/node-server';

import app from './app.ts';

// Shinro never touches this file, and nothing in it imports Shinro. Run it
// however you like:
//
//   node --watch --watch-path=src --import shinro/generate src/server.ts
//   tsx watch src/server.ts       (see `dev:tsx` — needs the preload too)
//   bun --watch src/server.ts
//   node dist/server.mjs          (after `tsdown`)
//
// The `--import shinro/generate` preload is dev-only and lives in the dev
// script, not in this file. Production runs the entry with nothing in front of
// it. Node owns the watching, the restarting, and the signals; the code below
// owns the listener and the drain.
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
