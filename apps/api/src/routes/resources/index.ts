import { zValidator } from '@hono/zod-validator';
import { defineHandler } from 'daroyan/app';
import { z } from 'zod';

const listResources = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  query: z.string().optional(),
});

const createResource = z.object({
  name: z.string().trim().min(1),
});

export const GET = defineHandler(zValidator('query', listResources), (c) => {
  const input = c.req.valid('query');
  return c.json(
    {
      input,
      resources: [
        {
          id: 'res_123',
          name: 'Example resource',
        },
      ],
    },
    200
  );
});

export const POST = defineHandler(zValidator('json', createResource), (c) => {
  const input = c.req.valid('json');
  return c.json(
    {
      resource: {
        id: 'res_new',
        name: input.name,
      },
    },
    201
  );
});
