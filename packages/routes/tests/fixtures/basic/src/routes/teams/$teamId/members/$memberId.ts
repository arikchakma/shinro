import { defineHandler } from 'daroyan/app';

export const GET = defineHandler((c) => {
  return c.json({
    memberId: c.req.param('memberId'),
    teamId: c.req.param('teamId'),
  });
});
