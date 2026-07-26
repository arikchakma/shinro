import { defineHandler } from 'shinro/app';

export const GET = defineHandler((c) => {
  return c.json({ service: 'prototype-api' as const }, 200);
});
