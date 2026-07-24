import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../app.ts";

export const beginMiddlewareChain = createMiddleware<AppEnv>(async (c, next) => {
  c.set("middlewareOrder", ["root:first"]);
  await next();
  c.header("x-middleware-order", c.var.middlewareOrder.join(","));
});

export const continueMiddlewareChain = createMiddleware<AppEnv>(async (c, next) => {
  c.var.middlewareOrder.push("root:second");
  await next();
});
