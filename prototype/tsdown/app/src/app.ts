import { routes } from '#shinro/routes';
import { defineApp } from 'shinro/app';

declare module 'shinro/app' {
  interface ShinroEnv {
    Variables: {
      requestId: string;
    };
  }
}

// `basePath` is Hono's, not Shinro's. One mechanism prefixes manual routes and
// mounted file routes alike, and it stays in the schema — so the generated
// client's URLs follow it for free, and there is no second prefix to keep in
// sync by hand.
const app = defineApp()
  .basePath('/v1')
  .use('*', async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set('requestId', requestId);
    await next();
    c.header('x-request-id', requestId);
  })
  .get('/manual', (c) => {
    return c.json({ feature: 'manual-route' as const }, 200);
  })
  // Global middleware must be registered before file routes.
  .route('/', routes())
  .notFound((c) => c.json({ error: 'NOT_FOUND' as const }, 404));

export default app;
