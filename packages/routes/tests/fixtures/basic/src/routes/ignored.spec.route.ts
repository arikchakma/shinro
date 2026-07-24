import { defineHandler } from 'daroyan/app';

export const GET = defineHandler((c) =>
  c.json({ shouldNotExist: true as const })
);
