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
 * The one piece of user boilerplate the redesign adds: `#shinro/*` has to be
 * declared in the app's package.json `imports`. Warn with the exact snippet when
 * it is missing or points somewhere other than `.shinro`. `shinro init` writes
 * the block, so this warning is for hand-wired projects and for someone who
 * edited it by hand.
 *
 * A relative import is NOT a mistake and must never warn. `import { routes } from
 * '../.shinro/routes.ts'` needs no package.json at all and resolves in every
 * runner and in tsc by construction — it is the escape hatch for anyone whose
 * package.json is generated or locked down. `#shinro/routes` is the documented
 * default only because it survives moving `app.ts`.
 */
export declare function validatePackageImports(options: {
  logger: ShinroLogger;
  outputDirectory: string;
  root: string;
}): Promise<void>;
