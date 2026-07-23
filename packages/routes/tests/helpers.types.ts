import {
  type DaroyanMiddleware,
  type DaroyanRoute,
  defineHandler,
  defineMiddleware,
  type ProjectEnv,
} from "../src/app.ts";

defineHandler((c) => c.text("ok"));
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

type TeamMiddleware = DaroyanMiddleware<{
  env: ProjectEnv;
  path: "/teams/:teamId";
}>;

defineMiddleware<TeamMiddleware>(async (c, next) => {
  const teamId: string = c.req.param("teamId");

  // @ts-expect-error An unknown parameter is possibly undefined.
  const memberId: string = c.req.param("memberId");

  void memberId;
  void teamId;
  await next();
});

type TeamRoute = DaroyanRoute<{
  env: ProjectEnv;
  params: { teamId: string };
  path: "/teams/:teamId";
}>;

defineHandler<TeamRoute>((c) => {
  const teamId: string = c.req.param("teamId");

  // @ts-expect-error An unknown parameter is possibly undefined.
  const memberId: string = c.req.param("memberId");

  return c.json({ memberId, teamId });
});
