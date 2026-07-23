import { Hono, type Env } from "hono";

export { defineHandler } from "./factory/handler.ts";
export type { DaroyanRoute } from "./factory/handler.ts";
export { defineMiddleware } from "./factory/middleware.ts";
export type { DaroyanMiddleware } from "./factory/middleware.ts";

export interface DaroyanProject {}

type ProjectApp = DaroyanProject extends { readonly app: infer App } ? App : Hono;

export type ProjectEnv = ProjectApp extends Hono<infer E, infer _Schema, infer _BasePath> ? E : Env;

export function defineApp<E extends Env = Env>(
  options?: ConstructorParameters<typeof Hono<E>>[0],
): Hono<E> {
  return new Hono<E>(options);
}
