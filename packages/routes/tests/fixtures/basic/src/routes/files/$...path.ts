import { defineHandler } from 'daroyan/app';

export const GET = defineHandler((c) => c.json({ path: c.req.param('path') }));
