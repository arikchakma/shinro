import { defineHandler } from 'shinro/app';

import type { Route } from './+types/$id.ts';

export const GET = defineHandler<Route.Handler>((c) => {
  return c.json({ id: c.req.param('id') });
});
