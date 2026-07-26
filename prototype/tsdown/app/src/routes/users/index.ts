import { zValidator } from '@hono/zod-validator';
import { defineHandler } from 'shinro/app';
import { z } from 'zod';

const createUser = z.object({
  email: z.string().email(),
  name: z.string().trim().min(1),
});

export const GET = defineHandler((c) => {
  return c.json({ users: [{ id: 'u_1', name: 'Ada' }] }, 200);
});

export const POST = defineHandler(zValidator('json', createUser), (c) => {
  const input = c.req.valid('json');
  return c.json({ user: { id: 'u_2', ...input } }, 201);
});
