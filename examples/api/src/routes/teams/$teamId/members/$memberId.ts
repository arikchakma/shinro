import { zValidator } from '@hono/zod-validator';
import { defineHandler } from 'shinro/app';
import { z } from 'zod';

import type { Route } from './+types/teams/$teamId/members/$memberId.ts';

export const GET = defineHandler(
  zValidator(
    'param',
    z.object({
      teamId: z.string(),
      memberId: z.string(),
    })
  ),
  (c) => {
    const params = c.req.valid('param');

    return c.json(
      {
        memberId: c.req.param('memberId'),
        teamId: c.req.param('teamId'),
      },
      200
    );
  }
);
