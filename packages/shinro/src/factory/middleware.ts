import type { Env } from 'hono';
import type { MiddlewareHandler } from 'hono/types';

import type { ProjectEnv } from '../app.ts';

/**
 * Unchanged from today. Worth stating what it does not do, because the emitter
 * now depends on it: every element is a plain `MiddlewareHandler` with no
 * `Input` and no typed response, and the env is declared through the `ShinroEnv`
 * augmentation rather than inferred along the chain. That is why the generated
 * router can compose a whole directory chain into one `every()` slot without
 * losing anything — there was never any type information in the extra slots.
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
