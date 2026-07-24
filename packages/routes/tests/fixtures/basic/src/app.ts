import { defineApp } from 'daroyan/app';
import { routes } from 'daroyan/routes';

// The project environment is declared once, here, by augmenting the interface
// `daroyan/app` exports. Route files pick it up through `ProjectEnv` without
// repeating a generic and without Daroyan reading this file's types.
declare module 'daroyan/app' {
  interface DaroyanEnv {
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
