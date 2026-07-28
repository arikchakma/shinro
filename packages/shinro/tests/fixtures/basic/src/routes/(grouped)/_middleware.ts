import { defineMiddleware } from 'shinro/app';

import type { Route } from './+types/(grouped)/_middleware.ts';

export default defineMiddleware<Route.Middleware>(async (c, next) => {
  c.header('x-group', 'grouped');
  await next();
});
