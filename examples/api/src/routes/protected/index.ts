import { defineHandler } from 'shinro/app';

export const GET = defineHandler((c) => {
  return c.json(
    {
      requestId: c.var.requestId,
      secret: 'shinro' as const,
    },
    200
  );
});
