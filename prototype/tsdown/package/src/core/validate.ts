import type { ShinroLogger } from './logger.ts';

/**
 * Was `validateTypeScriptConfig` — six conditions and a 30-line warning.
 * `${configDir}` in the shipped base config now carries `rootDirs` and
 * `include` correctly, so this collapses to one question.
 */
export declare function validateTypeScriptConfig(options: {
  logger: ShinroLogger;
  root: string;
}): Promise<void>;

/**
 * New, and the one piece of user boilerplate the redesign adds: `#shinro/*`
 * has to be declared in the app's package.json `imports`. Warn with the exact
 * snippet when it is missing or points somewhere other than `rpc.outDir`.
 */
export declare function validatePackageImports(options: {
  logger: ShinroLogger;
  outputDirectory: string;
  root: string;
}): Promise<void>;
