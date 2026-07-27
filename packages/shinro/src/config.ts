import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { OUTPUT_DIRECTORY } from './constants.ts';
import type { ShinroLogger } from './core/logger.ts';

/**
 * Where the app and its routes live, and nothing else. All of it is
 * JSON-serializable, so there is no config loader and no jiti/unconfig
 * dependency — `shinro.config.json` or `package.json#shinro`.
 *
 * There is no `basePath`: `defineApp().basePath('/v1')` is Hono's own, it covers
 * the app's manual routes as well as the file routes, and it stays in the schema
 * so the generated client follows it for free.
 */
export type ShinroConfig = {
  app?: string;
  ignoredRouteFiles?: string[];
  routes?: string;
};

/**
 * The output directory is not configurable: `shinro/tsconfig` hardcodes
 * `${configDir}/.shinro` in both `rootDirs` and `include`, so any other value
 * type-checks against declarations TypeScript cannot find.
 */
export type ResolvedShinroConfig = Required<ShinroConfig> & {
  root: string;
  /** Always `<root>/.shinro`. */
  outputDirectory: string;
};

const DEFAULTS = {
  app: 'src/app.ts',
  ignoredRouteFiles: [] as string[],
  routes: 'src/routes',
} satisfies Required<ShinroConfig>;

const CONFIG_FILE = 'shinro.config.json';

/**
 * Reads `shinro.config.json`, else `package.json#shinro`, else defaults.
 *
 * `overrides` is how an adapter passes inline options, so config-in-code stays
 * available without the core growing a loader:
 * adapter options > shinro.config.json > package.json#shinro > defaults.
 */
export async function loadConfig(
  root: string,
  logger: ShinroLogger,
  overrides?: ShinroConfig
): Promise<ResolvedShinroConfig> {
  const fromFile = await readConfigFile(resolve(root, CONFIG_FILE), logger);
  const fromPackage = await readPackageConfig(
    resolve(root, 'package.json'),
    logger
  );

  if (fromFile && fromPackage) {
    logger.warn(
      `[shinro] Both ${CONFIG_FILE} and package.json#shinro define configuration. ${CONFIG_FILE} wins; delete one so there is a single place to look.`
    );
  }

  const merged = {
    ...DEFAULTS,
    ...fromPackage,
    ...fromFile,
    ...stripUndefined(overrides ?? {}),
  };

  return {
    ...merged,
    outputDirectory: resolve(root, OUTPUT_DIRECTORY),
    root,
  };
}

/**
 * The nearest directory at or above `from` holding a `shinro.config.json` or a
 * `package.json`. The preloads and the CLI both need this, because `node
 * --import shinro/generate src/server.ts` can be run from anywhere in the
 * project — and resolving routes against the wrong root would generate an empty
 * route tree rather than failing.
 */
export async function findProjectRoot(
  from: string = process.cwd()
): Promise<string> {
  let directory = resolve(from);

  while (true) {
    for (const marker of [CONFIG_FILE, 'package.json']) {
      try {
        await access(resolve(directory, marker));
        return directory;
      } catch {
        // Keep looking.
      }
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return resolve(from);
    }
    directory = parent;
  }
}

async function readConfigFile(
  file: string,
  logger: ShinroLogger
): Promise<ShinroConfig | undefined> {
  const contents = await readJson(file);
  return contents === undefined
    ? undefined
    : pickConfig(contents, file, logger);
}

async function readPackageConfig(
  file: string,
  logger: ShinroLogger
): Promise<ShinroConfig | undefined> {
  const contents = await readJson(file);
  const shinro = (contents as { shinro?: unknown } | undefined)?.shinro;
  return shinro === undefined
    ? undefined
    : pickConfig(shinro, `${file}#shinro`, logger);
}

async function readJson(file: string): Promise<unknown> {
  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }

  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    // Falling back to defaults on unparseable JSON would generate a route tree
    // from a directory the user did not choose, so this is fatal rather than a
    // warning.
    throw new Error(
      `[shinro] Could not parse ${file}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
}

/**
 * Three keys, and anything else is a typo worth naming. `$schema` is allowed
 * through because editors want it and it describes the file rather than
 * configuring anything.
 */
function pickConfig(
  value: unknown,
  source: string,
  logger: ShinroLogger
): ShinroConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`[shinro] ${source} must be a JSON object.`);
  }

  const record = value as Record<string, unknown>;
  const config: ShinroConfig = {};

  for (const [key, entry] of Object.entries(record)) {
    if (key === '$schema') {
      continue;
    }
    if (key === 'app' || key === 'routes') {
      if (typeof entry !== 'string') {
        throw new Error(`[shinro] ${source}: "${key}" must be a string.`);
      }
      config[key] = entry;
      continue;
    }
    if (key === 'ignoredRouteFiles') {
      if (
        !Array.isArray(entry) ||
        entry.some((item) => typeof item !== 'string')
      ) {
        throw new Error(
          `[shinro] ${source}: "ignoredRouteFiles" must be an array of glob strings.`
        );
      }
      config.ignoredRouteFiles = entry as string[];
      continue;
    }

    logger.warn(
      `[shinro] ${source}: unknown option "${key}". Shinro reads "routes", "app", and "ignoredRouteFiles".`
    );
  }

  return config;
}

// An adapter that spreads its own options object would otherwise let an explicit
// `undefined` overwrite a real value from the config file.
function stripUndefined(config: ShinroConfig): ShinroConfig {
  return Object.fromEntries(
    Object.entries(config).filter(([, value]) => value !== undefined)
  );
}
