import { defineHandler } from 'shinro/app';

export const GET = defineHandler((c) => c.json({ secret: true as const }, 200));
