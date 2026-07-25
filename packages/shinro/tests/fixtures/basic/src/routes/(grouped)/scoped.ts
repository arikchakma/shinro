import { defineHandler } from 'shinro/app';

import type { Route } from './+types/scoped.ts';

export const GET = defineHandler<Route.Handler>((c) => {
  return c.json({ scoped: true as const }, 200);
});
