import { defineMiddleware } from 'daroyan/app';

// A group directory scopes this middleware to a set of sibling URLs without
// putting "(authed)" in any of them, so `/v1/orders` is protected while its
// neighbour `/v1/health` stays public.
export default defineMiddleware(async (c, next) => {
  if (c.req.header('authorization') !== 'Bearer demo') {
    return c.json({ error: 'UNAUTHORIZED' as const }, 401);
  }

  await next();
});
