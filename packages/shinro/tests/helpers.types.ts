import { zValidator } from '@hono/zod-validator';
import type { Env } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';
import { every } from 'hono/combine';
import { cors } from 'hono/cors';
import type { Input, MiddlewareHandler } from 'hono/types';
import { z } from 'zod';

import { defineHandler, defineMiddleware } from '../src/app.ts';
import type { ShinroMiddleware, ShinroRoute, ProjectEnv } from '../src/app.ts';

defineHandler((c) => c.text('ok'));
defineMiddleware(async (_c, next) => {
  await next();
});
defineMiddleware(async (c, next) => {
  const requestId: string = c.var.requestId;

  // @ts-expect-error The project env is the only thing writable here.
  c.set('sessionId', requestId);

  void requestId;
  await next();
});

// @ts-expect-error A route tuple requires a final handler.
defineHandler();

// @ts-expect-error A directory middleware tuple requires at least one middleware.
defineMiddleware();

defineMiddleware(bearerAuth({ token: 'demo' }));
defineMiddleware(cors());
defineMiddleware(every(cors(), bearerAuth({ token: 'demo' })));

declare const foreignMiddleware: MiddlewareHandler<
  Env,
  string,
  Input,
  Response
>;
defineMiddleware(foreignMiddleware);

defineMiddleware(bearerAuth({ token: 'demo' }), async (c, next) => {
  const requestId: string = c.var.requestId;
  void requestId;
  await next();
});

const guard = defineMiddleware(async (c, next) => {
  if (!c.req.header('authorization')) {
    return c.json({ error: 'UNAUTHORIZED' as const }, 401);
  }

  await next();
});

const unauthorized: { _status: 401 } = null as unknown as Exclude<
  Awaited<ReturnType<(typeof guard)[0]>>,
  undefined | void
>;
void unauthorized;

type TeamMiddleware = ShinroMiddleware<{
  env: ProjectEnv;
  path: '/teams/:teamId';
}>;

defineMiddleware<TeamMiddleware>(async (c, next) => {
  const teamId: string = c.req.param('teamId');

  // @ts-expect-error An unknown parameter is possibly undefined.
  const memberId: string = c.req.param('memberId');

  void memberId;
  void teamId;
  await next();
});

type TeamRoute = ShinroRoute<{
  env: ProjectEnv;
  params: { teamId: string };
  path: '/teams/:teamId';
}>;

defineHandler<TeamRoute>((c) => {
  const teamId: string = c.req.param('teamId');

  // @ts-expect-error An unknown parameter is possibly undefined.
  const memberId: string = c.req.param('memberId');

  return c.json({ memberId, teamId });
});

const routeParams = z.object({ id: z.string().min(3) });
const routeBody = z.object({ name: z.string().min(1) });

defineHandler(
  zValidator('param', routeParams),
  zValidator('json', routeBody),
  (c) => {
    const id: string = c.req.valid('param').id;
    const name: string = c.req.valid('json').name;

    return c.json({ id, name });
  }
);

defineHandler(
  async (_c, next) => {
    await next();
  },
  zValidator('json', routeBody),
  (c) => c.json({ name: c.req.valid('json').name })
);

defineHandler(
  async (_c, next) => {
    await next();
  },
  async (_c, next) => {
    await next();
  },
  zValidator('param', routeParams),
  (c) => c.json({ id: c.req.valid('param').id })
);

const validateParams = zValidator('param', routeParams);
const validateBody = zValidator('json', routeBody);

defineHandler(validateParams, validateBody, (c) =>
  c.json({
    id: c.req.valid('param').id,
    name: c.req.valid('json').name,
  })
);

defineHandler(zValidator('param', routeParams), (c) => {
  // @ts-expect-error Only the validated keys are readable.
  c.req.valid('json');

  return c.json({ id: c.req.valid('param').id });
});

defineHandler<TeamRoute>(
  async (_c, next) => {
    await next();
  },
  (c) => c.json({ teamId: c.req.param('teamId') })
);

const auditTeam = defineMiddleware<TeamMiddleware>(async (_c, next) => {
  await next();
});

defineHandler<TeamRoute>(auditTeam[0], (c) =>
  c.json({ teamId: c.req.param('teamId') })
);

defineHandler<TeamRoute>(zValidator('json', routeBody), (c) => {
  const teamId: string = c.req.param('teamId');

  // @ts-expect-error Nothing was inferred into the handler's input.
  c.req.valid('json');

  return c.json({ teamId });
});
