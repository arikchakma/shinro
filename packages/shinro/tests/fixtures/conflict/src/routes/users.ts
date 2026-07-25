import { defineHandler } from 'shinro/app';

export const GET = defineHandler((c) => c.json({ source: 'file' as const }));
