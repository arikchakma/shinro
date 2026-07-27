import type { ShinroLogger } from './core/logger.ts';

/**
 * Everything left after tsdown took over `entry` and `build`. All of it is
 * JSON-serializable, so there is no config loader and no jiti/unconfig
 * dependency — `shinro.config.json` or `package.json#shinro`.
 *
 * `basePath` is gone. It was a second prefix mechanism, applying to file routes
 * but not to the app, so an app with a base path hand-wrote the prefix on its
 * manual routes and nothing checked the two halves agreed.
 * `defineApp().basePath('/v1')` is Hono's own, covers both, and stays in the
 * schema so the generated client follows it for free.
 */
export type ShinroConfig = {
  app?: string;
  ignoredRouteFiles?: string[];
  routes?: string;
};

/**
 * `rpc` is gone, and nothing replaced it.
 *
 * `enabled` was a toggle on `client.ts`, which is one small type-only file that
 * costs nothing to emit and is the reason most people are here. Off is not a
 * state worth supporting.
 *
 * `outDir` was never configurable in practice: `shinro/tsconfig` hardcodes
 * `${configDir}/.shinro` in both `rootDirs` and `include`, so any other value
 * type-checks against declarations TypeScript can't find. A knob that has one
 * working setting is not a knob.
 */
export type ResolvedShinroConfig = Required<ShinroConfig> & {
  root: string;
  /** Always `<root>/.shinro`. */
  outputDirectory: string;
};

/**
 * Reads `shinro.config.json`, else `package.json#shinro`, else defaults.
 *
 * `overrides` is how an adapter passes inline options, so config-in-code stays
 * available without the core growing a loader:
 * adapter options > shinro.config.json > package.json#shinro > defaults.
 */
export declare function loadConfig(
  root: string,
  logger: ShinroLogger,
  overrides?: ShinroConfig
): Promise<ResolvedShinroConfig>;
