import { Hono } from 'hono';
import type { Env } from 'hono';

// Unchanged from today, and the only entry point the running server imports.
// Nothing here reaches for the filesystem, a parser, or a bundler, so importing
// `shinro/app` in a Worker or on the edge pulls in Hono and nothing else.
export { defineHandler } from './factory/handler.ts';
export type { ShinroRoute } from './factory/handler.ts';
export { defineMiddleware } from './factory/middleware.ts';
export type { ShinroMiddleware } from './factory/middleware.ts';

/**
 * The project's Hono environment, declared by the application rather than
 * inferred from it:
 *
 * ```ts
 * declare module 'shinro/app' {
 *   interface ShinroEnv {
 *     Variables: { requestId: string };
 *     Bindings: HttpBindings;
 *   }
 * }
 * ```
 *
 * `Bindings` and `Variables` are both `object` in Hono, so an un-augmented
 * `ShinroEnv` is structurally `Env` and augmenting it narrows the inherited
 * members. Nothing reads the application's source for this, which is what keeps
 * `app.ts` free to import the generated router without a type cycle.
 */
export interface ShinroEnv extends Env {}

export type ProjectEnv = ShinroEnv;

export function defineApp<E extends Env = ProjectEnv>(
  options?: ConstructorParameters<typeof Hono<E>>[0]
): Hono<E> {
  return new Hono<E>(options);
}
