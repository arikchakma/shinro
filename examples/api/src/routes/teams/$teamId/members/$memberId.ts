import { zValidator } from '@hono/zod-validator';
import { defineHandler } from 'shinro/app';
import { z } from 'zod';

import type { Route } from './+types/teams/$teamId/members/$memberId.ts';

// Both halves of nested dynamic typing in one file: the generated `Route.Handler`
// types `c.req.param`, and the validator types `c.req.valid('param')`. They agree
// because generate cross-checks the schema's keys against the filename's.
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
