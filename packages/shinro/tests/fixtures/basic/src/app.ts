import { defineApp } from 'shinro/app';
import { routes } from 'shinro/routes';

// The project environment is declared once, here, by augmenting the interface
// `shinro/app` exports. Route files pick it up through `ProjectEnv` without
// repeating a generic and without Shinro reading this file's types.
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
