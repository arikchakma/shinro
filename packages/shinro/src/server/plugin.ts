import { access, readdir } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';

import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite-plus';

import {
  CLIENT_FILE,
  CLIENT_ID,
  GENERATED_ENTRIES,
  ROUTES_FILE,
  ROUTES_ID,
  RPC_FILE,
  RPC_ID,
} from '../constants.ts';
import { createSources } from './codegen.ts';
import { validateTypeScriptConfig } from './config.ts';
import { DevelopmentProcess } from './dev.ts';
import { warnForMissingClientExport } from './package.ts';
import { isAtOrWithin } from './path.ts';
import { affectsRouteTree } from './scanner.ts';
import { writeGeneratedTypes } from './typegen.ts';

export type ShinroOptions = {
  app?: string;
  basePath?: '/' | `/${string}`;
  build?: {
    fileName?: `${string}.mjs`;
    minify?: boolean;
    outDir?: string;
    sourcemap?: false | 'inline';
    unbundle?: boolean;
  };
  entry?: string;
  ignoredRouteFiles?: string[];
  rpc?: {
    enabled?: boolean;
    outDir?: string;
  };
  routes?: string;
};

/**
 * What `shinro()` exposes on `plugin.api`, so tools such as `shinro typegen`
 * can drive generation explicitly instead of relying on it happening as a side
 * effect of resolving the config.
 */
export type ShinroApi = {
  generate: () => Promise<{ outputDirectory: string } | undefined>;
};

export function shinro(options: ShinroOptions = {}): Plugin {
  let resolvedConfig: ResolvedConfig | undefined;
  let outputDirectory: string | undefined;
  let generation = Promise.resolve();

  const generate = async () => {
    if (!resolvedConfig || !outputDirectory) {
      return undefined;
    }

    const sources = await createSources(
      resolvedConfig,
      options,
      outputDirectory
    );
    await writeGeneratedTypes(outputDirectory, sources, {
      rpcEnabled: options.rpc?.enabled !== false,
    });

    return { outputDirectory };
  };

  const api: ShinroApi = { generate };

  return {
    name: 'shinro',
    enforce: 'pre',
    api,

    config(userConfig, env) {
      if (env.command !== 'build') {
        return {
          ssr: {
            noExternal: ['shinro'],
          },
        };
      }

      const root = resolve(userConfig.root ?? process.cwd());
      const entry = resolve(root, options.entry ?? 'src/server.ts');
      const build = options.build ?? {};
      const unbundle = build.unbundle ?? true;

      return {
        build: {
          minify: build.minify ?? false,
          outDir: build.outDir ?? 'dist',
          rolldownOptions: {
            output: unbundle
              ? {
                  chunkFileNames: '[name].mjs',
                  entryFileNames: '[name].mjs',
                  preserveModules: true,
                  preserveModulesRoot: dirname(entry),
                }
              : {
                  entryFileNames: build.fileName ?? 'server.mjs',
                },
          },
          sourcemap: build.sourcemap ?? false,
          ssr: entry,
        },
        ssr: unbundle
          ? {
              // Unbundle mode keeps every dependency external so `dist` mirrors
              // only the user's source tree. `shinro` is a linked workspace
              // package, so it must be forced external to stay out of `dist`;
              // `shinro/routes` is resolved to the generated file by this
              // plugin before externalization, so it is still emitted.
              external: ['shinro'],
              noExternal: [],
            }
          : {
              noExternal: true,
            },
      };
    },

    async configResolved(config) {
      if (
        config.plugins.filter((plugin) => plugin.name === 'shinro').length > 1
      ) {
        throw new Error(
          '[shinro] Multiple shinro() plugins were installed. v0.1 supports one Shinro application per TypeScript project.'
        );
      }

      resolvedConfig = config;
      outputDirectory = resolve(config.root, options.rpc?.outDir ?? '.shinro');
      await assertGeneratedDirectory(config.root, outputDirectory);

      // The development child loads this same config only so it can run the
      // user's entry. The parent already generated `.shinro` and reported its
      // diagnostics before spawning it, so repeating that work here would print
      // every warning twice and contend on the generation lock for nothing.
      if (isDevelopmentChild()) {
        return;
      }

      if (config.command === 'build') {
        await assertServerEntry(
          resolve(config.root, options.entry ?? 'src/server.ts')
        );
      }
      await validateTypeScriptConfig({
        logger: config.logger,
        outputDirectory,
        root: config.root,
      });
      if (options.rpc?.enabled !== false) {
        await warnForMissingClientExport({
          logger: config.logger,
          outputDirectory,
          root: config.root,
        });
      }
      await generate();
    },

    async configureServer(server) {
      const routesDirectory = resolve(
        server.config.root,
        options.routes ?? 'src/routes'
      );
      const entryFile = resolve(
        server.config.root,
        options.entry ?? 'src/server.ts'
      );
      const runsUserEntry =
        !server.config.server.middlewareMode && !isDevelopmentChild();
      if (runsUserEntry) {
        await assertServerEntry(entryFile);
      }
      let developmentProcess: DevelopmentProcess | undefined;
      const onRouteTreeChange = (file: string) => {
        // Route directories hold more than routes — fixtures, snapshots,
        // READMEs — and none of those change what gets generated.
        if (
          !isAtOrWithin(routesDirectory, file) ||
          !affectsRouteTree(routesDirectory, file, options.ignoredRouteFiles)
        ) {
          return;
        }

        generation = generation
          .then(generate)
          .then(() => {
            invalidateGeneratedRouter(
              server,
              resolve(
                outputDirectory ?? resolve(server.config.root, '.shinro'),
                ROUTES_FILE
              )
            );
            developmentProcess?.restart();
          })
          .catch((error: unknown) => {
            server.config.logger.error(
              error instanceof Error
                ? (error.stack ?? error.message)
                : String(error)
            );
          });
      };

      server.watcher.on('add', onRouteTreeChange);
      server.watcher.on('change', onRouteTreeChange);
      server.watcher.on('unlink', onRouteTreeChange);

      if (runsUserEntry) {
        const processController = new DevelopmentProcess({
          configFile: server.config.configFile,
          entry: entryFile,
          logger: server.config.logger,
          root: server.config.root,
        });
        developmentProcess = processController;
        // Any watched module can be part of the running server, including
        // workspace packages outside the app's own source directory, so the
        // restart set is not limited to the app directory. It is limited to
        // importable source files: a server that writes a log, cache, or
        // database file at runtime would otherwise restart itself forever.
        // Route changes restart through `onRouteTreeChange`, and generated
        // output must never restart anything.
        const restart = (file: string) => {
          if (
            isSourceModule(file) &&
            !isAtOrWithin(routesDirectory, file) &&
            !isAtOrWithin(
              outputDirectory ?? resolve(server.config.root, '.shinro'),
              file
            )
          ) {
            processController.restart();
          }
        };

        server.watcher.on('add', restart);
        server.watcher.on('change', restart);
        server.watcher.on('unlink', restart);
        server.httpServer?.once('close', () => {
          void processController.close();
        });
        processController.start();
      }
    },

    // Every specifier the generated declarations name has to resolve here too,
    // or the types promise a module the bundler cannot find. The RPC pair is
    // only offered when RPC is on, since those files are not written otherwise.
    resolveId(id) {
      if (!outputDirectory) {
        return;
      }
      if (id === ROUTES_ID) {
        return resolve(outputDirectory, ROUTES_FILE);
      }
      if (options.rpc?.enabled === false) {
        return;
      }
      if (id === CLIENT_ID) {
        return resolve(outputDirectory, CLIENT_FILE);
      }
      if (id === RPC_ID) {
        return resolve(outputDirectory, RPC_FILE);
      }
    },

    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter(
        (output) => output.type === 'chunk'
      );
      const assets = Object.values(bundle).filter(
        (output) => output.type === 'asset'
      );
      const unbundle = options.build?.unbundle ?? true;
      const entryFile = options.entry ?? 'src/server.ts';
      const expectedEntryFile = unbundle
        ? `${basename(entryFile, extname(entryFile))}.mjs`
        : (options.build?.fileName ?? 'server.mjs');
      const unexpectedEntries = chunks.filter(
        (chunk) => chunk.isEntry && chunk.fileName !== expectedEntryFile
      );

      if (unexpectedEntries.length > 0) {
        throw new Error(
          `[shinro] Production output used ${unexpectedEntries
            .map((chunk) => chunk.fileName)
            .join(
              ', '
            )}, but Shinro expected ${expectedEntryFile} as the server entry filename.`
        );
      }

      if (!unbundle && chunks.length > 1) {
        throw new Error(
          `[shinro] Production output contains multiple JavaScript chunks (${chunks
            .map((chunk) => chunk.fileName)
            .join(
              ', '
            )}). Shinro requires a single entry artifact; replace dynamic imports or bundle them inline.`
        );
      }

      if (assets.length > 0) {
        this.warn(
          `[shinro] Production output contains an external runtime asset (${assets
            .map((asset) => asset.fileName)
            .join(', ')}), which weakens the one-entry deployment model.`
        );
      }
    },
  };
}

const SOURCE_MODULE_EXTENSIONS = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);

function isSourceModule(file: string): boolean {
  return SOURCE_MODULE_EXTENSIONS.has(extname(file));
}

function isDevelopmentChild(): boolean {
  return process.env.SHINRO_DEV_CHILD === '1';
}

async function assertGeneratedDirectory(
  root: string,
  outputDirectory: string
): Promise<void> {
  const path = relative(root, outputDirectory);
  if (path === '') {
    throw new Error(
      '[shinro] rpc.outDir cannot be the project root; choose a dedicated generated directory such as .shinro.'
    );
  }
  if (path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error(
      `[shinro] rpc.outDir must stay inside the project root: ${outputDirectory}`
    );
  }

  // Shinro owns everything in this directory, including deleting files it no
  // longer generates. Refuse to adopt a directory that already holds unrelated
  // content, so a misconfigured `rpc.outDir` cannot point at source.
  let entries: string[];
  try {
    entries = await readdir(outputDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') {
      throw new Error(
        `[shinro] rpc.outDir is not a directory: ${outputDirectory}`
      );
    }
    throw error;
  }

  // Match against every name Shinro may own rather than a single marker file:
  // a concurrent process can observe this directory mid-generation, when only
  // some of the generated files exist yet.
  const owned = new Set<string>(GENERATED_ENTRIES);
  const foreign = entries.filter(
    (entry) => !owned.has(entry) && !entry.endsWith('.tmp')
  );
  if (foreign.length === 0) {
    return;
  }

  throw new Error(
    `[shinro] Refusing to generate into ${outputDirectory}: it already contains files Shinro did not generate (${foreign
      .slice(0, 5)
      .join(
        ', '
      )}).\nPoint rpc.outDir at a dedicated directory such as .shinro, or empty this one first.`
  );
}

async function assertServerEntry(entry: string): Promise<void> {
  try {
    await access(entry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `[shinro] Server entry not found: ${entry}\nCreate it or configure shinro({ entry: "path/to/server.ts" }).`,
        { cause: error }
      );
    }
    throw error;
  }
}

function invalidateGeneratedRouter(
  server: ViteDevServer,
  routesFile: string
): void {
  for (const environment of Object.values(server.environments)) {
    const module = environment.moduleGraph.getModuleById(routesFile);
    if (module) {
      environment.moduleGraph.invalidateModule(module);
    }
    environment.hot.send({ type: 'full-reload', path: '*' });
  }
}
