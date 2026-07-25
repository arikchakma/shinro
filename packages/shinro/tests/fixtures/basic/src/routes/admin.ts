import { Hono } from 'hono';

const admin = new Hono()
  .get('/', (c) => c.json({ section: 'admin' as const }))
  .get('/stats', (c) => c.json({ activeUsers: 42 }));

export default admin;
