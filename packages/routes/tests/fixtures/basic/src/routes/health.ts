import { defineHandler } from 'daroyan/app';

export const GET = defineHandler((c) => {
  return c.json({ ok: true as const });
});

export const POST = defineHandler((c) => {
  return c.json({ created: true as const }, 201);
});
