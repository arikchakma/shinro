import type { Env } from 'hono';
import type { MiddlewareHandler } from 'hono/types';

import type { ProjectEnv } from '../app.ts';

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

type DirectoryMiddlewareEnv<Middleware extends AnyMiddleware | undefined> =
  Middleware extends AnyMiddleware ? Middleware['env'] : ProjectEnv;

type DirectoryMiddlewarePath<Middleware extends AnyMiddleware | undefined> =
  Middleware extends AnyMiddleware ? Middleware['path'] : string;

type ProjectSlot<Middleware extends AnyMiddleware | undefined> =
  MiddlewareHandler<
    DirectoryMiddlewareEnv<Middleware>,
    DirectoryMiddlewarePath<Middleware>
  >;

type ForeignSlot<Middleware extends AnyMiddleware | undefined> =
  MiddlewareHandler<any, DirectoryMiddlewarePath<Middleware>>;

export function defineMiddleware<
  Middleware extends AnyMiddleware | undefined = undefined,
  const T extends [ProjectSlot<Middleware>, ...ProjectSlot<Middleware>[]] = [
    ProjectSlot<Middleware>,
    ...ProjectSlot<Middleware>[],
  ],
>(...middleware: T): T;
export function defineMiddleware<
  Middleware extends AnyMiddleware | undefined = undefined,
  const T extends [ForeignSlot<Middleware>, ...ForeignSlot<Middleware>[]] = [
    ForeignSlot<Middleware>,
    ...ForeignSlot<Middleware>[],
  ],
>(...middleware: T): T;
export function defineMiddleware(
  ...middleware: MiddlewareHandler<any, string>[]
): MiddlewareHandler<any, string>[] {
  return middleware;
}
