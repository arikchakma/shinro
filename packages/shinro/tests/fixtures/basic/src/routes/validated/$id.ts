import { zValidator } from '@hono/zod-validator';
import { defineHandler } from 'shinro/app';
import { z } from 'zod';

const params = z.object({
  id: z.string().min(3),
});

export const GET = defineHandler(zValidator('param', params), (c) => {
  return c.json({ id: c.req.valid('param').id }, 200);
});
