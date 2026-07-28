import type { Env } from 'hono';
import type { MiddlewareHandler } from 'hono/types';

import type { ProjectEnv } from '../app.ts';

/**
 * Every element is a plain `MiddlewareHandler`: no `Input`, no typed response,
 * and the env comes from the `ShinroEnv` augmentation rather than from inference
 * along the chain. That is what lets the generated router collapse a whole
 * directory chain into one `every()` slot without losing type information.
 */
export type ShinroMiddleware<
  T extends {
    env: Env;
    path: string;
  },
> = T;

type AnyMiddleware = ShinroMiddleware<{
  env: Env;
  path: string;
}>;

type DirectoryMiddlewarePath<Middleware extends AnyMiddleware | undefined> =
  Middleware extends AnyMiddleware ? Middleware['path'] : string;

export function defineMiddleware<
  Middleware extends AnyMiddleware | undefined = undefined,
  const T extends [
    MiddlewareHandler<
      Middleware extends AnyMiddleware ? Middleware['env'] : ProjectEnv,
      DirectoryMiddlewarePath<Middleware>
    >,
    ...MiddlewareHandler<
      Middleware extends AnyMiddleware ? Middleware['env'] : ProjectEnv,
      DirectoryMiddlewarePath<Middleware>
    >[],
  ] = [
    MiddlewareHandler<
      Middleware extends AnyMiddleware ? Middleware['env'] : ProjectEnv,
      DirectoryMiddlewarePath<Middleware>
    >,
    ...MiddlewareHandler<
      Middleware extends AnyMiddleware ? Middleware['env'] : ProjectEnv,
      DirectoryMiddlewarePath<Middleware>
    >[],
  ],
>(...middleware: T): T {
  return middleware;
}
