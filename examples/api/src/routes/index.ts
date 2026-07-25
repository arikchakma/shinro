import { defineHandler } from 'shinro/app';

export const GET = defineHandler((c) => {
  return c.json(
    {
      name: 'Shinro API showcase' as const,
      endpoints: [
        '/v1/health',
        '/v1/orders',
        '/v1/sitemap.xml',
        '/v1/resources',
        '/v1/resources/:id',
        '/v1/teams/:teamId/members/:memberId',
        '/v1/files/:path',
        '/v1/methods',
        '/v1/pipeline',
        '/v1/protected',
        '/v1/admin',
        '/v1/admin/stats',
        '/v1/manual',
      ],
      requestId: c.var.requestId,
    },
    200
  );
});
