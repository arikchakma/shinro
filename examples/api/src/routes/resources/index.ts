import { zValidator } from '@hono/zod-validator';
import { defineHandler } from 'shinro/app';

import { listResources, resourceInput, resourceQuery } from './-resource.ts';

export const GET = defineHandler(zValidator('query', resourceQuery), (c) => {
  const input = c.req.valid('query');
  return c.json(
    {
      input,
      resources: listResources(input.limit),
    },
    200
  );
});

export const POST = defineHandler(zValidator('json', resourceInput), (c) => {
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
