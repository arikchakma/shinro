import { zValidator } from '@hono/zod-validator';
import { defineHandler } from 'shinro/app';

import { findResource, resourceInput, resourceParams } from './-resource.ts';

export const GET = defineHandler(zValidator('param', resourceParams), (c) => {
  const resource = findResource(c.req.valid('param').id);
  if (!resource) {
    return c.json({ error: 'RESOURCE_NOT_FOUND' as const }, 404);
  }

  return c.json({ resource }, 200);
});

export const PATCH = defineHandler(
  zValidator('param', resourceParams),
  zValidator('json', resourceInput),
  (c) => {
    const resource = findResource(c.req.valid('param').id);
    if (!resource) {
      return c.json({ error: 'RESOURCE_NOT_FOUND' as const }, 404);
    }

    return c.json(
      {
        resource: {
          ...resource,
          name: c.req.valid('json').name,
        },
      },
      200
    );
  }
);

export const DELETE = defineHandler(
  zValidator('param', resourceParams),
  (c) => {
    const { id } = c.req.valid('param');
    if (!findResource(id)) {
      return c.json({ error: 'RESOURCE_NOT_FOUND' as const }, 404);
    }

    return c.json({ deleted: id }, 200);
  }
);
