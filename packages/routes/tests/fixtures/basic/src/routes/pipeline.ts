import { defineHandler } from 'daroyan/app';

export const GET = defineHandler(
  async (c, next) => {
    c.header('x-pipeline-first', 'yes');
    await next();
  },
  async (c, next) => {
    c.header('x-pipeline-second', 'yes');
    await next();
  },
  (c) => c.json({ complete: true as const })
);
