import type { Env } from "hono";
import type { MiddlewareHandler } from "hono/types";
import type { ProjectEnv } from "../app.ts";

export type DaroyanMiddleware<
  T extends {
    env: Env;
    path: string;
  },
> = T;

type AnyMiddleware = DaroyanMiddleware<{
  env: Env;
  path: string;
}>;

type DirectoryMiddlewarePath<Middleware extends AnyMiddleware | undefined> =
  Middleware extends AnyMiddleware ? Middleware["path"] : string;

export function defineMiddleware<
  Middleware extends AnyMiddleware | undefined = undefined,
  const T extends [
    MiddlewareHandler<
      Middleware extends AnyMiddleware ? Middleware["env"] : ProjectEnv,
      DirectoryMiddlewarePath<Middleware>
    >,
    ...MiddlewareHandler<
      Middleware extends AnyMiddleware ? Middleware["env"] : ProjectEnv,
      DirectoryMiddlewarePath<Middleware>
    >[],
  ] = [
    MiddlewareHandler<
      Middleware extends AnyMiddleware ? Middleware["env"] : ProjectEnv,
      DirectoryMiddlewarePath<Middleware>
    >,
    ...MiddlewareHandler<
      Middleware extends AnyMiddleware ? Middleware["env"] : ProjectEnv,
      DirectoryMiddlewarePath<Middleware>
    >[],
  ],
>(...middleware: T): T {
  return middleware;
}
