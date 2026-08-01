import { zValidator } from '@hono/zod-validator';
import { defineHandler } from 'shinro/app';
import { z } from 'zod';

import type { Route } from './+types/teams/$teamId/members/$memberId.ts';

// The generated `Route.Handler` types `c.req.param`, the validator types
// `c.req.valid('param')`, and generate cross-checks the two.
export const GET = defineHandler<Route.Handler>(
  zValidator(
    'param',
    z.object({
      teamId: z.string(),
      memberId: z.string(),
    })
  ),
  (c) => {
    return c.json(
      {
        memberId: c.req.param('memberId'),
        teamId: c.req.param('teamId'),
      },
      200
    );
  }
);
