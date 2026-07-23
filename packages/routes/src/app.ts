import { Hono, type Env } from "hono";
import type { BlankInput, Handler, HandlerResponse, Input, MiddlewareHandler } from "hono/types";

export interface DaroyanProject {}

type ProjectApp = DaroyanProject extends { readonly app: infer App } ? App : Hono;

export type ProjectEnv = ProjectApp extends Hono<infer E, infer _Schema, infer _BasePath> ? E : Env;

export function defineHandler<
  E extends Env = ProjectEnv,
  P extends string = "/",
  I extends Input = BlankInput,
  R extends HandlerResponse<any> = HandlerResponse<any>,
>(handler: Handler<E, P, I, R>): [Handler<E, P, I, R>] {
  return [handler];
}

export function defineMiddleware<const T extends MiddlewareHandler<ProjectEnv>[]>(
  ...middleware: T
): T {
  return middleware;
}

export function defineApp<E extends Env = Env>(
  options?: ConstructorParameters<typeof Hono<E>>[0],
): Hono<E> {
  return new Hono<E>(options);
}
