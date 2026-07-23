import { defineHandler } from "daroyan/app";
import type { Route } from "./+types/$id";

export const GET = defineHandler<Route.Handler>((c) => {
  return c.json({ id: c.req.param("id") });
});
