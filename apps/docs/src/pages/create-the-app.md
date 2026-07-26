---
layout: ../layouts/Layout.astro
title: Create the app
description: Create a Hono app, mount Shinro's generated router, and start a Node.js or Bun server.
---

# Create the app

`defineApp()` creates a regular Hono instance with the project environment already applied. Mount the generated router with Hono's native `route()` method.

```ts
// src/app.ts
import { logger } from 'hono/logger';
import { defineApp } from 'shinro/app';
import { routes } from 'shinro/routes';

const app = defineApp()
  .use('*', logger())
  .route('/', routes())
  .onError((error, c) => {
    console.error(error);
    return c.json({ error: 'INTERNAL_ERROR' as const }, 500);
  });

export default app;
```

`route()` returns the same Hono instance and copies the generated router's schema onto it. Runtime routing and the RPC contract therefore describe one application.

## Middleware order

Mount generated routes after global middleware. Hono composes handlers in registration order, so middleware registered after `routes()` does not wrap file routes.

```ts
const app = defineApp()
  .use('*', logger()) // wraps file routes
  .route('/', routes())
  .use('*', lateMiddleware); // does not wrap file routes
```

Shinro warns when it detects this common mistake or when an app never mounts `routes()`.

## Start on Node.js

Server lifecycle stays in application code:

```ts
// src/server.ts
import { serve } from '@hono/node-server';
import app from './app.ts';

const server = serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 3000),
});

process.once('SIGTERM', () => server.close());
```

Keeping the native server handle means your application can drain requests, close databases, stop workers, and choose its own exit behavior.

## Start on Bun

Bun can serve the same Hono application directly:

```ts
// src/server.ts
import app from './app.ts';

Bun.serve({
  fetch: app.fetch,
  port: Number(Bun.env.PORT ?? 3000),
});
```

Shinro does not abstract either runtime. The only shared layer is the generated Hono router.
