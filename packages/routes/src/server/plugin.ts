import { access } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { Plugin, ResolvedConfig, ViteDevServer } from "vite-plus";
import { ENTRY_ID, RESOLVED_ENTRY_ID } from "../constants.ts";
import { createSources } from "./codegen.ts";
import { DevelopmentProcess } from "./dev-process.ts";
import { warnForMissingClientExport } from "./package-diagnostics.ts";
import { writeGeneratedTypes } from "./typegen.ts";
import { validateTypeScriptConfig } from "./typescript-config.ts";

export type DaroyanOptions = {
  app?: string;
  basePath?: "/" | `/${string}`;
  build?: {
    fileName?: `${string}.mjs`;
    minify?: boolean;
    outDir?: string;
    sourcemap?: false | "inline";
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
  let entrySource: string | undefined;
  let resolvedConfig: ResolvedConfig | undefined;
  let outputDirectory: string | undefined;
  let generation = Promise.resolve();

  const generate = async () => {
    if (!resolvedConfig || !outputDirectory) {
      return;
    }

    const sources = await createSources(resolvedConfig, options, outputDirectory);
    entrySource = sources.entry;
    await writeGeneratedTypes(outputDirectory, sources, {
      rpcEnabled: options.rpc?.enabled !== false,
    });
  };

  return {
    name: "daroyan",
    enforce: "pre",

    config(userConfig, environment) {
      if (environment.command !== "build") {
        return {
          ssr: {
            noExternal: ["daroyan"],
          },
        };
      }

      const root = resolve(userConfig.root ?? process.cwd());
      const entry = resolve(root, options.entry ?? "app/server.ts");
      const build = options.build ?? {};

      return {
        build: {
          minify: build.minify ?? false,
          outDir: build.outDir ?? "dist",
          rolldownOptions: {
            output: {
              entryFileNames: build.fileName ?? "server.mjs",
            },
          },
          sourcemap: build.sourcemap ?? false,
          ssr: entry,
        },
        ssr: {
          noExternal: true,
        },
      };
    },

    async configResolved(config) {
      if (config.plugins.filter((plugin) => plugin.name === "daroyan").length > 1) {
        throw new Error(
          "[daroyan] Multiple daroyan() plugins were installed. v0.1 supports one Daroyan application per TypeScript project.",
        );
      }

      resolvedConfig = config;
      outputDirectory = resolve(config.root, options.rpc?.outDir ?? ".daroyan");
      assertGeneratedDirectory(config.root, outputDirectory);
      if (config.command === "build") {
        await assertServerEntry(resolve(config.root, options.entry ?? "app/server.ts"));
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
      const routesDirectory = resolve(server.config.root, options.routes ?? "app/routes");
      const appFile = resolve(server.config.root, options.app ?? "app/app.ts");
      const entryFile = resolve(server.config.root, options.entry ?? "app/server.ts");
      const sourceDirectories = [dirname(appFile), dirname(entryFile)];
      const runsUserEntry =
        !server.config.server.middlewareMode && process.env.DAROYAN_DEV_CHILD !== "1";
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
            invalidateEntry(server);
            developmentProcess?.restart();
          })
          .catch((error: unknown) => {
            server.config.logger.error(
              error instanceof Error ? (error.stack ?? error.message) : String(error),
            );
          });
      };

      server.watcher.on("add", onRouteTreeChange);
      server.watcher.on("change", onRouteTreeChange);
      server.watcher.on("unlink", onRouteTreeChange);

      if (runsUserEntry) {
        const processController = new DevelopmentProcess({
          configFile: server.config.configFile,
          entry: entryFile,
          logger: server.config.logger,
          root: server.config.root,
        });
        developmentProcess = processController;
        const restart = (file: string) => {
          if (
            !isWithin(routesDirectory, file) &&
            !isWithin(outputDirectory ?? resolve(server.config.root, ".daroyan"), file) &&
            sourceDirectories.some((directory) => isWithin(directory, file))
          ) {
            processController.restart();
          }
        };

        server.watcher.on("add", restart);
        server.watcher.on("change", restart);
        server.watcher.on("unlink", restart);
        server.httpServer?.once("close", () => {
          void processController.close();
        });
        processController.start();
      }
    },

    resolveId(id) {
      if (id === ENTRY_ID) {
        return RESOLVED_ENTRY_ID;
      }
    },

    load(id) {
      if (id === RESOLVED_ENTRY_ID) {
        if (!entrySource) {
          throw new Error(
            "Daroyan's application entry was loaded before route discovery completed.",
          );
        }

        return entrySource;
      }
    },

    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((output) => output.type === "chunk");
      const assets = Object.values(bundle).filter((output) => output.type === "asset");
      const expectedEntryFile = options.build?.fileName ?? "server.mjs";
      const unexpectedEntries = chunks.filter(
        (chunk) => chunk.isEntry && chunk.fileName !== expectedEntryFile,
      );

      if (unexpectedEntries.length > 0) {
        throw new Error(
          `[daroyan] Production output used ${unexpectedEntries
            .map((chunk) => chunk.fileName)
            .join(", ")}, but Daroyan expected ${expectedEntryFile} as the server entry filename.`,
        );
      }

      if (chunks.length > 1) {
        throw new Error(
          `[daroyan] Production output contains multiple JavaScript chunks (${chunks
            .map((chunk) => chunk.fileName)
            .join(
              ", ",
            )}). Daroyan requires a single entry artifact; replace dynamic imports or bundle them inline.`,
        );
      }

      if (assets.length > 0) {
        resolvedConfig?.logger.warn(
          `[daroyan] Production output contains an external runtime asset (${assets
            .map((asset) => asset.fileName)
            .join(", ")}), which weakens the one-entry deployment model.`,
        );
      }
    },
  };
}

function assertGeneratedDirectory(root: string, outputDirectory: string): void {
  const path = relative(root, outputDirectory);
  if (path === "") {
    throw new Error(
      "[daroyan] rpc.outDir cannot be the project root; choose a dedicated generated directory such as .daroyan.",
    );
  }
  if (path === ".." || path.startsWith(`..${sep}`)) {
    throw new Error(`[daroyan] rpc.outDir must stay inside the project root: ${outputDirectory}`);
  }
}

async function assertServerEntry(entry: string): Promise<void> {
  try {
    await access(entry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `[daroyan] Server entry not found: ${entry}\nCreate it or configure daroyan({ entry: "path/to/server.ts" }).`,
        { cause: error },
      );
    }
    throw error;
  }
}

function isWithin(directory: string, file: string): boolean {
  const path = relative(directory, file);
  return path !== ".." && !path.startsWith(`..${sep}`);
}

function invalidateEntry(server: ViteDevServer): void {
  for (const environment of Object.values(server.environments)) {
    const module = environment.moduleGraph.getModuleById(RESOLVED_ENTRY_ID);
    if (module) {
      environment.moduleGraph.invalidateModule(module);
    }
    environment.hot.send({ type: "full-reload", path: "*" });
  }
}
