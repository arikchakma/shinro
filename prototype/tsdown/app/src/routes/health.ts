import { defineHandler } from 'shinro/app';

export const GET = defineHandler((c) => {
  return c.json({ status: 'ok' as const, uptime: process.uptime() }, 200);
});
