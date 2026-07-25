import { defineHandler } from 'shinro/app';

export const GET = defineHandler(
  async (c, next) => {
    c.set('requestId', 'req_local');
    await next();
  },
  (c) => c.json({ requestId: c.var.requestId })
);
