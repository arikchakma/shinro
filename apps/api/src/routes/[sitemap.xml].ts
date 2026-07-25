import { defineHandler } from 'shinro/app';

// `[...]` escapes the route conventions, so this file serves `/v1/sitemap.xml`
// rather than a dynamic or grouped segment.
export const GET = defineHandler((c) => {
  return c.text('<urlset />', 200, {
    'content-type': 'application/xml',
  });
});
