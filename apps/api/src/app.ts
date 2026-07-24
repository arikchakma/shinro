import { defineApp } from 'daroyan/app';

export type AppEnv = {
  Variables: {
    requestId: string;
  };
};

const app = defineApp<AppEnv>()
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
  .onError((error, c) => {
    console.error(error);
    return c.json({ error: 'INTERNAL_ERROR' as const }, 500);
  })
  .notFound((c) => {
    return c.json({ error: 'NOT_FOUND' as const }, 404);
  });

export default app;
