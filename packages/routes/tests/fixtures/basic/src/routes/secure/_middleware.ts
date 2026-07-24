import { defineMiddleware } from "daroyan/app";

export default defineMiddleware(async (c, next) => {
  if (c.req.header("authorization") !== "Bearer valid") {
    return c.json({ error: "UNAUTHORIZED" as const }, 401);
  }

  await next();
});
