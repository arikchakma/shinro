import { defineHandler } from 'daroyan/app';

export const GET = defineHandler((c) => {
  return c.json({ requestId: c.var.requestId });
});
