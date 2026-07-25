import { defineHandler } from 'shinro/app';

export const GET = defineHandler((c) => c.json({ route: 'users' as const }));
