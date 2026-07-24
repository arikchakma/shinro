import { defineHandler } from 'daroyan/app';

export const PUT = defineHandler((c) => {
  return c.json({ method: 'PUT' as const }, 200);
});

export const PATCH = defineHandler((c) => {
  return c.json({ method: 'PATCH' as const }, 200);
});

export const DELETE = defineHandler((c) => {
  return c.json({ method: 'DELETE' as const }, 200);
});

export const OPTIONS = defineHandler((c) => {
  return c.json({ method: 'OPTIONS' as const }, 200);
});
