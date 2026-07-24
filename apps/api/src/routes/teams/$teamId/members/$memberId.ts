import { defineHandler } from 'daroyan/app';

import type { Route } from './+types/$memberId.ts';

export const GET = defineHandler<Route.Handler>((c) => {
  return c.json(
    {
      memberId: c.req.param('memberId'),
      teamId: c.req.param('teamId'),
    },
    200
  );
});
