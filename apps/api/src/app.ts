import { defineApp } from 'daroyan/app';
import { routes } from 'daroyan/routes';

declare module 'daroyan/app' {
  interface DaroyanEnv {
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
    return c.json(
      {
        feature: 'manual-route' as const,
        requestId: c.var.requestId,
      },
      200
    );
  })
  // File routes mount after the global middleware, so it wraps them. Hono
  // composes handlers in registration order, and `route()` copies the generated
  // router's routes onto this instance rather than nesting a second router.
  .route('/', routes())
  .onError((error, c) => {
    console.error(error);
    return c.json({ error: 'INTERNAL_ERROR' as const }, 500);
  })
  .notFound((c) => {
    return c.json({ error: 'NOT_FOUND' as const }, 404);
  });

export default app;
