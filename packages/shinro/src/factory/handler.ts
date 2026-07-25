import type { Env } from 'hono';
import { createFactory } from 'hono/factory';
import type { Factory } from 'hono/factory';
import type {
  BlankInput,
  H,
  Handler,
  HandlerResponse,
  Input,
} from 'hono/types';

import type { ProjectEnv } from '../app.ts';

export type ShinroRoute<
  T extends {
    env: Env;
    params: Record<string, string>;
    path: string;
  },
> = T;

type AnyRoute = ShinroRoute<{
  env: Env;
  params: Record<string, string>;
  path: string;
}>;

type RouteEnv<Route extends AnyRoute | undefined> = Route extends AnyRoute
  ? Route['env']
  : ProjectEnv;

type RoutePath<Route extends AnyRoute | undefined> = Route extends AnyRoute
  ? Route['path']
  : string;

type MiddlewarePath<Route extends AnyRoute | undefined> = Route extends AnyRoute
  ? Route['path']
  : string;

type DefineHandler = {
  <
    Route extends AnyRoute | undefined = undefined,
    I extends Input = BlankInput,
    R extends HandlerResponse<any> = HandlerResponse<any>,
  >(
    handler: Handler<RouteEnv<Route>, RoutePath<Route>, I, R>
  ): [Handler<RouteEnv<Route>, RoutePath<Route>, I, R>];
  <
    Route extends AnyRoute | undefined = undefined,
    I extends Input = BlankInput,
    R1 extends HandlerResponse<any> = HandlerResponse<any>,
    R2 extends HandlerResponse<any> = HandlerResponse<any>,
  >(
    middleware: H<RouteEnv<Route>, MiddlewarePath<Route>, I, R1>,
    handler: Handler<RouteEnv<Route>, MiddlewarePath<Route>, I, R2>
  ): [
    H<RouteEnv<Route>, MiddlewarePath<Route>, I, R1>,
    Handler<RouteEnv<Route>, MiddlewarePath<Route>, I, R2>,
  ];
  <
    Route extends AnyRoute | undefined = undefined,
    const Handlers extends [
      H<RouteEnv<Route>, MiddlewarePath<Route>>,
      ...H<RouteEnv<Route>, MiddlewarePath<Route>>[],
    ] = [
      H<RouteEnv<Route>, MiddlewarePath<Route>>,
      ...H<RouteEnv<Route>, MiddlewarePath<Route>>[],
    ],
  >(
    ...handlers: Handlers
  ): Handlers;
};

const handlerFactory: Factory<ProjectEnv> = createFactory<ProjectEnv>();

export const defineHandler = handlerFactory.createHandlers as DefineHandler &
  typeof handlerFactory.createHandlers;
