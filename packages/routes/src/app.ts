import { Hono, type Env } from "hono";
import { createFactory, type Factory } from "hono/factory";
import type { BlankInput, H, Handler, HandlerResponse, Input, MiddlewareHandler } from "hono/types";

export interface DaroyanProject {}

type ProjectApp = DaroyanProject extends { readonly app: infer App } ? App : Hono;

export type ProjectEnv = ProjectApp extends Hono<infer E, infer _Schema, infer _BasePath> ? E : Env;

export type DaroyanRoute<
  T extends {
    env: Env;
    params: Record<string, string>;
    path: string;
  },
> = T;

export type DaroyanMiddleware<
  T extends {
    env: Env;
    path: string;
  },
> = T;

type AnyRoute = DaroyanRoute<{
  env: Env;
  params: Record<string, string>;
  path: string;
}>;

type AnyMiddleware = DaroyanMiddleware<{
  env: Env;
  path: string;
}>;

type RouteEnv<Route extends AnyRoute | undefined> = Route extends AnyRoute
  ? Route["env"]
  : ProjectEnv;

type RoutePath<Route extends AnyRoute | undefined> = Route extends AnyRoute ? Route["path"] : "/";

type MiddlewarePath<Route extends AnyRoute | undefined> = Route extends AnyRoute
  ? Route["path"]
  : string;

type DirectoryMiddlewarePath<Middleware extends AnyMiddleware | undefined> =
  Middleware extends AnyMiddleware ? Middleware["path"] : string;

type PrimaryDefineHandler = {
  <
    Route extends AnyRoute | undefined = undefined,
    I extends Input = BlankInput,
    R extends HandlerResponse<any> = HandlerResponse<any>,
  >(
    handler: Handler<RouteEnv<Route>, RoutePath<Route>, I, R>,
  ): [Handler<RouteEnv<Route>, RoutePath<Route>, I, R>];
  <
    Route extends AnyRoute | undefined = undefined,
    I extends Input = BlankInput,
    R1 extends HandlerResponse<any> = HandlerResponse<any>,
    R2 extends HandlerResponse<any> = HandlerResponse<any>,
  >(
    middleware: H<RouteEnv<Route>, MiddlewarePath<Route>, I, R1>,
    handler: Handler<RouteEnv<Route>, MiddlewarePath<Route>, I, R2>,
  ): [
    H<RouteEnv<Route>, MiddlewarePath<Route>, I, R1>,
    Handler<RouteEnv<Route>, MiddlewarePath<Route>, I, R2>,
  ];
  <
    Route extends AnyRoute | undefined = undefined,
    const Handlers extends [
      H<RouteEnv<Route>, MiddlewarePath<Route>>,
      ...H<RouteEnv<Route>, MiddlewarePath<Route>>[],
    ] = [H<RouteEnv<Route>, MiddlewarePath<Route>>, ...H<RouteEnv<Route>, MiddlewarePath<Route>>[]],
  >(
    ...handlers: Handlers
  ): Handlers;
};

const handlerFactory: Factory<ProjectEnv> = createFactory<ProjectEnv>();

export const defineHandler = handlerFactory.createHandlers as PrimaryDefineHandler &
  typeof handlerFactory.createHandlers;

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

export function defineApp<E extends Env = Env>(
  options?: ConstructorParameters<typeof Hono<E>>[0],
): Hono<E> {
  return new Hono<E>(options);
}
