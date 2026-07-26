import { routes } from '#shinro/routes';
import { defineApp } from 'shinro/app';

declare module 'shinro/app' {
  interface ShinroEnv {
    Variables: {
      requestId: string;
    };
  }
}

const app = defineApp()
  .use('*', async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set('requestId', requestId);
    await next();
    c.header('x-request-id', requestId);
  })
  .get('/v1/manual', (c) => {
    return c.json({ feature: 'manual-route' as const }, 200);
  })
  // Global middleware must be registered before file routes.
  .route('/', routes())
  .notFound((c) => c.json({ error: 'NOT_FOUND' as const }, 404));

export default app;
