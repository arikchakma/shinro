import { defineHandler } from 'daroyan/app';

export const GET = defineHandler((c) => {
  return c.json(
    {
      orders: ['ord_1', 'ord_2'] as const,
      requestId: c.var.requestId,
    },
    200
  );
});
