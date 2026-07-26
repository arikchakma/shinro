import { defineHandler } from 'shinro/app';

import type { Route } from './+types/users/$id.ts';

// The generated declaration supplies `c.req.param('id')` and the RPC path.
// It is optional — drop the generic and Shinro still infers the route.
export const GET = defineHandler<Route.Handler>((c) => {
  const id = c.req.param('id');
  if (id === 'missing') {
    return c.json({ error: 'USER_NOT_FOUND' as const }, 404);
  }

  return c.json({ user: { id, name: 'Ada' } }, 200);
});
