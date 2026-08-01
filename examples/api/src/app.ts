import { defineApp } from 'shinro/app';

import { routes } from '#shinro/routes';

declare module 'shinro/app' {
  interface ShinroEnv {
    Variables: {
      requestId: string;
    };
  }
}

// `basePath` is Hono's, not Shinro's: it prefixes the manual route and the
// mounted file routes alike, and stays in the schema the client is built from.
const app = defineApp()
  .basePath('/v1')
  .use('*', async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set('requestId', requestId);
    await next();
    c.header('x-request-id', requestId);
  })
  .get('/manual', (c) => {
    return c.json(
      {
        feature: 'manual-route' as const,
        requestId: c.var.requestId,
      },
      200
    );
  })
  // Global middleware must be registered before file routes.
  .route('/', routes())
  .onError((error, c) => {
    console.error(error);
    return c.json({ error: 'INTERNAL_ERROR' as const }, 500);
  })
  .notFound((c) => {
    return c.json({ error: 'NOT_FOUND' as const }, 404);
  });

export default app;
