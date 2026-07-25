import { defineHandler } from 'shinro/app';

export const GET = defineHandler((c) => c.json({ path: c.req.param('path') }));
