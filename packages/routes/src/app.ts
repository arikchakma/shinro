import { Hono } from 'hono';
import type { Env } from 'hono';

export { defineHandler } from './factory/handler.ts';
export type { DaroyanRoute } from './factory/handler.ts';
export { defineMiddleware } from './factory/middleware.ts';
export type { DaroyanMiddleware } from './factory/middleware.ts';

/**
 * The project's Hono environment, declared by the application rather than
 * inferred from it:
 *
 * ```ts
 * declare module 'daroyan/app' {
 *   interface DaroyanEnv {
 *     Variables: { requestId: string };
 *     Bindings: HttpBindings;
 *   }
 * }
 * ```
 *
 * `Bindings` and `Variables` are both `object` in Hono, so an un-augmented
 * `DaroyanEnv` is structurally `Env` and augmenting it narrows the inherited
 * members. Nothing reads the application's source for this, which is what keeps
 * `app.ts` free to import the generated router without a type cycle.
 */
export interface DaroyanEnv extends Env {}

export type ProjectEnv = DaroyanEnv;

export function defineApp<E extends Env = ProjectEnv>(
  options?: ConstructorParameters<typeof Hono<E>>[0]
): Hono<E> {
  return new Hono<E>(options);
}
