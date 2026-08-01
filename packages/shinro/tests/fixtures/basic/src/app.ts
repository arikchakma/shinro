import { defineApp } from 'shinro/app';

import { routes } from '#shinro/routes';

// Declared once, here: route files pick it up through `ProjectEnv`.
declare module 'shinro/app' {
  interface ShinroEnv {
    Variables: {
      requestId: string;
    };
  }
}

const app = defineApp()
  .use('*', async (c, next) => {
    c.set('requestId', 'req_123');
    await next();
  })
  .get('/manual', (c) => {
    return c.json({ manual: true as const });
  })
  .route('/', routes());

export default app;
