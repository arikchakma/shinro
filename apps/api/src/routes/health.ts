import { defineHandler } from 'daroyan/app';

export const GET = defineHandler((c) => {
  return c.json(
    {
      ok: true as const,
      requestId: c.var.requestId,
    },
    200
  );
});
