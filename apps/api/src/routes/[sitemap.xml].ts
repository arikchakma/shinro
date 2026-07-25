import { defineHandler } from 'shinro/app';

export const GET = defineHandler((c) => {
  return c.text('<urlset />', 200, {
    'content-type': 'application/xml',
  });
});
