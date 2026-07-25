import { defineHandler } from 'shinro/app';

export const GET = defineHandler((c) => c.json({ route: 'api' as const }));
