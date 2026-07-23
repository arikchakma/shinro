import { defineMiddleware } from "daroyan/app";

export default defineMiddleware(
  async (c, next) => {
    c.header("x-middleware-order", "first");
    await next();
  },
  async (c, next) => {
    c.header("x-middleware-order", `${c.res.headers.get("x-middleware-order")},second`);
    await next();
  },
);
