import { defineMiddleware } from "daroyan/app";
import type { Route } from "./+types/_middleware.ts";

export default defineMiddleware<Route.Middleware>(
  async (c, next) => {
    c.header("x-middleware-order", "first");
    await next();
  },
  async (c, next) => {
    c.header("x-middleware-order", `${c.res.headers.get("x-middleware-order")},second`);
    await next();
  },
);
