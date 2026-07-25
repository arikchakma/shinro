import { defineHandler } from 'shinro/app';

export const GET = defineHandler((c) =>
  c.json({ shouldNotExist: true as const })
);
