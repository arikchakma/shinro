import { Hono } from 'hono';

const admin = new Hono()
  .get('/', (c) => {
    return c.json({ section: 'admin' as const }, 200);
  })
  .get('/stats', (c) => {
    return c.json({ activeRoutes: 11 }, 200);
  });

export default admin;
