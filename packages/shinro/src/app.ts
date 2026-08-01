import { Hono } from 'hono';
import type { Env } from 'hono';

export { defineHandler } from './factory/handler.ts';
export type { ShinroRoute } from './factory/handler.ts';
export { defineMiddleware } from './factory/middleware.ts';
export type { ShinroMiddleware } from './factory/middleware.ts';

/**
 * The project's Hono environment, declared by the application:
 *
 * ```ts
 * declare module 'shinro/app' {
 *   interface ShinroEnv {
 *     Variables: { requestId: string };
 *     Bindings: HttpBindings;
 *   }
 * }
 * ```
 */
export interface ShinroEnv extends Env {}

export type ProjectEnv = ShinroEnv;

export function defineApp<E extends Env = ProjectEnv>(
  options?: ConstructorParameters<typeof Hono<E>>[0]
): Hono<E> {
  return new Hono<E>(options);
}
