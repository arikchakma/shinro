import { defineHandler } from 'shinro/app';

import type { Route } from './+types/files/$...path.ts';

export const GET = defineHandler<Route.Handler>((c) => {
  return c.json(
    {
      path: c.req.param('path'),
    },
    200
  );
});
