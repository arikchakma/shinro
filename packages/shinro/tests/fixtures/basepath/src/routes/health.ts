import { defineHandler } from 'shinro/app';

export const GET = defineHandler((c) => c.json({ ok: true as const }));
