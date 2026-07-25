import { defineHandler } from 'shinro/app';

export const GET = defineHandler((c) => c.json({ source: 'index' as const }));
