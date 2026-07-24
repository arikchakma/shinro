import { defineHandler } from 'daroyan/app';

export const GET = defineHandler((c) => c.json({ secret: true as const }, 200));
