import type { ShinroLogger } from './core/logger.ts';

/**
 * Everything left after tsdown took over `entry` and `build`. All of it is
 * JSON-serializable, so there is no config loader and no jiti/unconfig
 * dependency — `shinro.config.json` or `package.json#shinro`.
 */
export type ShinroConfig = {
  app?: string;
  basePath?: '/' | `/${string}`;
  ignoredRouteFiles?: string[];
  routes?: string;
  rpc?: {
    enabled?: boolean;
    outDir?: string;
  };
};

export type ResolvedShinroConfig = Required<
  Omit<ShinroConfig, 'rpc'>
> & {
  root: string;
  rpc: { enabled: boolean; outDir: string };
};

/** Reads `shinro.config.json`, else `package.json#shinro`, else defaults. */
export declare function loadConfig(
  root: string,
  logger: ShinroLogger
): Promise<ResolvedShinroConfig>;
