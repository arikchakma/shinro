import { defineMiddleware } from 'shinro/app';

import type { Route } from './+types/_middleware.ts';

// A group directory, so this middleware wraps `/scoped` without `(grouped)`
// appearing in the URL. The companion type also proves the generated `+types`
// overlay resolves through a parenthesized directory.
export default defineMiddleware<Route.Middleware>(async (c, next) => {
  c.header('x-group', 'grouped');
  await next();
});
