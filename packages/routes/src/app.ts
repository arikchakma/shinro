import { Hono, type Env } from "hono";

export { defineHandler } from "./factory/handler";
export type { DaroyanRoute } from "./factory/handler";
export { defineMiddleware } from "./factory/middleware";
export type { DaroyanMiddleware } from "./factory/middleware";

export interface DaroyanProject {}

type ProjectApp = DaroyanProject extends { readonly app: infer App } ? App : Hono;

export type ProjectEnv = ProjectApp extends Hono<infer E, infer _Schema, infer _BasePath> ? E : Env;

export function defineApp<E extends Env = Env>(
  options?: ConstructorParameters<typeof Hono<E>>[0],
): Hono<E> {
  return new Hono<E>(options);
}
