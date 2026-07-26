import { zValidator } from '@hono/zod-validator';
import { defineHandler } from 'shinro/app';
import { z } from 'zod';

export const GET = defineHandler(
  zValidator(
    'param',
    z.object({
      id: z.string().min(3),
    })
  ),
  (c) => {
    return c.json({ id: c.req.valid('param').id }, 200);
  }
);

export const PATCH = defineHandler(
  zValidator(
    'param',
    z.object({
      id: z.string().min(3),
    })
  ),
  zValidator(
    'json',
    z.object({
      name: z.string().trim().min(1),
    })
  ),
  (c) => {
    return c.json(
      {
        id: c.req.valid('param').id,
        name: c.req.valid('json').name,
      },
      200
    );
  }
);
