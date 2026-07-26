import { defineMiddleware } from 'shinro/app';

export default defineMiddleware(async (c, next) => {
  const startedAt = performance.now();
  await next();
  c.header('x-response-time', `${Math.round(performance.now() - startedAt)}ms`);
});
