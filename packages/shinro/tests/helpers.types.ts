import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

import { defineHandler, defineMiddleware } from '../src/app.ts';
import type { ShinroMiddleware, ShinroRoute, ProjectEnv } from '../src/app.ts';

defineHandler((c) => c.text('ok'));
defineMiddleware(async (_c, next) => {
  await next();
});
defineMiddleware(async (c, next) => {
  const requestId: string = c.var.requestId;
  void requestId;
  await next();
});

// @ts-expect-error A route tuple requires a final handler.
defineHandler();

// @ts-expect-error A directory middleware tuple requires at least one middleware.
defineMiddleware();

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

// Each validator contributes its own key, and the final handler reads the
// accumulation of everything before it.
defineHandler(
  zValidator('param', routeParams),
  zValidator('json', routeBody),
  (c) => {
    const id: string = c.req.valid('param').id;
    const name: string = c.req.valid('json').name;

    return c.json({ id, name });
  }
);

// Plain middleware carries no input of its own and must not interrupt the
// accumulation of the validators that follow it.
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

// Hoisting the validators must stay equivalent to spelling them inline.
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

// Route-local middleware is welcome alongside the route generic: it carries no
// input of its own, so nothing needs inferring past the explicit argument.
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

// A validator may precede the handler here too, but the explicit route generic
// stops TypeScript inferring its input, so only the filename-derived parameters
// are readable. It still rejects invalid requests; what it loses is the type,
// in the handler and in the generated client alike.
defineHandler<TeamRoute>(zValidator('json', routeBody), (c) => {
  const teamId: string = c.req.param('teamId');

  // @ts-expect-error Nothing was inferred into the handler's input.
  c.req.valid('json');

  return c.json({ teamId });
});
