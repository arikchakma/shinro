import { defineMiddleware } from 'shinro/app';

export default defineMiddleware(async (c, next) => {
  if (c.req.header('authorization') !== 'Bearer demo') {
    return c.json({ error: 'UNAUTHORIZED' as const }, 401);
  }

  await next();
});
