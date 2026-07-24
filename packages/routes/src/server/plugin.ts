import { access, readdir } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';

import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite-plus';

import {
  ENTRY_FILE,
  ENTRY_ID,
  GENERATED_ENTRIES,
  LEGACY_GENERATED_ENTRIES,
} from '../constants.ts';
import { createSources } from './codegen.ts';
import { validateTypeScriptConfig } from './config.ts';
import { DevelopmentProcess } from './dev.ts';
import { warnForMissingClientExport } from './package.ts';
import { writeGeneratedTypes } from './typegen.ts';

export type DaroyanOptions = {
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

export function daroyan(options: DaroyanOptions = {}): Plugin {
  let resolvedConfig: ResolvedConfig | undefined;
  let outputDirectory: string | undefined;
  let generation = Promise.resolve();

  const generate = async () => {
    if (!resolvedConfig || !outputDirectory) {
      return;
    }

    const sources = await createSources(
      resolvedConfig,
      options,
      outputDirectory
    );
    await writeGeneratedTypes(outputDirectory, sources, {
      rpcEnabled: options.rpc?.enabled !== false,
    });
  };

  return {
    name: 'daroyan',
    enforce: 'pre',

    config(userConfig, environment) {
      if (environment.command !== 'build') {
        return {
          ssr: {
            noExternal: ['daroyan'],
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
              // only the user's source tree. `daroyan` is a linked workspace
              // package, so it must be forced external to stay out of `dist`;
              // its virtual `daroyan/entry` module is resolved by this plugin
              // before externalization, so it remains inlined regardless.
              external: ['daroyan'],
              noExternal: [],
            }
          : {
              // The default single-artifact build inlines every dependency.
              noExternal: true,
            },
      };
    },

    async configResolved(config) {
      if (
        config.plugins.filter((plugin) => plugin.name === 'daroyan').length > 1
      ) {
        throw new Error(
          '[daroyan] Multiple daroyan() plugins were installed. v0.1 supports one Daroyan application per TypeScript project.'
        );
      }

      resolvedConfig = config;
      outputDirectory = resolve(config.root, options.rpc?.outDir ?? '.daroyan');
      await assertGeneratedDirectory(config.root, outputDirectory);

      // The development child loads this same config only so it can run the
      // user's entry. The parent already generated `.daroyan` and reported its
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
        if (!isWithin(routesDirectory, file)) {
          return;
        }

        generation = generation
          .then(generate)
          .then(() => {
            invalidateEntry(
              server,
              resolve(
                outputDirectory ?? resolve(server.config.root, '.daroyan'),
                ENTRY_FILE
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
            !isWithin(routesDirectory, file) &&
            !isWithin(
              outputDirectory ?? resolve(server.config.root, '.daroyan'),
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

    resolveId(id) {
      if (id === ENTRY_ID) {
        if (!outputDirectory) {
          return;
        }

        return resolve(outputDirectory, ENTRY_FILE);
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
          `[daroyan] Production output used ${unexpectedEntries
            .map((chunk) => chunk.fileName)
            .join(
              ', '
            )}, but Daroyan expected ${expectedEntryFile} as the server entry filename.`
        );
      }

      if (!unbundle && chunks.length > 1) {
        throw new Error(
          `[daroyan] Production output contains multiple JavaScript chunks (${chunks
            .map((chunk) => chunk.fileName)
            .join(
              ', '
            )}). Daroyan requires a single entry artifact; replace dynamic imports or bundle them inline.`
        );
      }

      if (assets.length > 0) {
        resolvedConfig?.logger.warn(
          `[daroyan] Production output contains an external runtime asset (${assets
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
  return process.env.DAROYAN_DEV_CHILD === '1';
}

async function assertGeneratedDirectory(
  root: string,
  outputDirectory: string
): Promise<void> {
  const path = relative(root, outputDirectory);
  if (path === '') {
    throw new Error(
      '[daroyan] rpc.outDir cannot be the project root; choose a dedicated generated directory such as .daroyan.'
    );
  }
  if (path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error(
      `[daroyan] rpc.outDir must stay inside the project root: ${outputDirectory}`
    );
  }

  // Daroyan owns everything in this directory, including deleting files it no
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
        `[daroyan] rpc.outDir is not a directory: ${outputDirectory}`
      );
    }
    throw error;
  }

  // Match against every name Daroyan may own rather than a single marker file:
  // a concurrent process can observe this directory mid-generation, when only
  // some of the generated files exist yet.
  const owned = new Set<string>([
    ...GENERATED_ENTRIES,
    ...LEGACY_GENERATED_ENTRIES,
  ]);
  const foreign = entries.filter(
    (entry) => !owned.has(entry) && !entry.endsWith('.tmp')
  );
  if (foreign.length === 0) {
    return;
  }

  throw new Error(
    `[daroyan] Refusing to generate into ${outputDirectory}: it already contains files Daroyan did not generate (${foreign
      .slice(0, 5)
      .join(
        ', '
      )}).\nPoint rpc.outDir at a dedicated directory such as .daroyan, or empty this one first.`
  );
}

async function assertServerEntry(entry: string): Promise<void> {
  try {
    await access(entry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `[daroyan] Server entry not found: ${entry}\nCreate it or configure daroyan({ entry: "path/to/server.ts" }).`,
        { cause: error }
      );
    }
    throw error;
  }
}

function isWithin(directory: string, file: string): boolean {
  const path = relative(directory, file);
  return path !== '..' && !path.startsWith(`..${sep}`);
}

function invalidateEntry(server: ViteDevServer, entryFile: string): void {
  for (const environment of Object.values(server.environments)) {
    const module = environment.moduleGraph.getModuleById(entryFile);
    if (module) {
      environment.moduleGraph.invalidateModule(module);
    }
    environment.hot.send({ type: 'full-reload', path: '*' });
  }
}
