import { zValidator } from '@hono/zod-validator';
import { defineHandler } from 'shinro/app';
import { z } from 'zod';

const resourceParams = z.object({
  id: z.string().min(3),
});

const updateResource = z.object({
  name: z.string().trim().min(1),
});

export const GET = defineHandler(zValidator('param', resourceParams), (c) => {
  const { id } = c.req.valid('param');
  if (id === 'missing') {
    return c.json({ error: 'RESOURCE_NOT_FOUND' as const }, 404);
  }

  return c.json(
    {
      resource: {
        id,
        name: 'Example resource',
      },
    },
    200
  );
});

export const PATCH = defineHandler(
  zValidator('param', resourceParams),
  zValidator('json', updateResource),
  (c) => {
    const { id } = c.req.valid('param');
    const input = c.req.valid('json');
    return c.json(
      {
        resource: {
          id,
          name: input.name,
        },
      },
      200
    );
  }
);

export const DELETE = defineHandler(
  zValidator('param', resourceParams),
  (c) => {
    return c.json(
      {
        deleted: c.req.valid('param').id,
      },
      200
    );
  }
);
