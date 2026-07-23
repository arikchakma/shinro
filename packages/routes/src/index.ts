import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { parseAst, type Plugin, type ResolvedConfig } from "vite-plus";

const ENTRY_ID = "daroyan/entry";
const RESOLVED_ENTRY_ID = "\0daroyan/entry";
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

export type DaroyanOptions = {
  app?: string;
  routes?: string;
};

type Route = {
  file: string;
  methods: (typeof HTTP_METHODS)[number][];
  middleware: string[];
  path: string;
};

export function daroyan(options: DaroyanOptions = {}): Plugin {
  let entrySource: string | undefined;

  return {
    name: "daroyan",
    enforce: "pre",

    async configResolved(config) {
      const sources = await createSources(config, options);
      entrySource = sources.entry;
      await writeGeneratedTypes(config.root, sources.rpc, sources.project);
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
  };
}

async function createSources(
  config: ResolvedConfig,
  options: DaroyanOptions,
): Promise<{ entry: string; project: string; rpc: string }> {
  const appFile = resolve(config.root, options.app ?? "app/app.ts");
  const routesDirectory = resolve(config.root, options.routes ?? "app/routes");
  const routes = await discoverRoutes(routesDirectory);

  const imports = [
    `import app from ${JSON.stringify(toVitePath(appFile))};`,
    ...routes.map(
      (route, index) => `import * as route${index} from ${JSON.stringify(toVitePath(route.file))};`,
    ),
    ...routes.flatMap((route, routeIndex) =>
      route.middleware.map(
        (file, middlewareIndex) =>
          `import route${routeIndex}Middleware${middlewareIndex} from ${JSON.stringify(
            toVitePath(file),
          )};`,
      ),
    ),
  ];

  const registrations = routes.flatMap((route, index) =>
    route.methods.map(
      (method) =>
        `app.on(${JSON.stringify(method)}, ${JSON.stringify(route.path)}, ${middlewareSpreads(
          route,
          index,
        )}...route${index}.${method});`,
    ),
  );

  const rpcImports = [
    'import { Hono } from "hono";',
    'import type { ProjectEnv } from "daroyan/app";',
    ...routes.flatMap((route, index) => [
      ...route.methods.map(
        (method) =>
          `import { ${method} as route${index}${method} } from ${JSON.stringify(
            generatedImport(config.root, route.file),
          )};`,
      ),
      ...route.middleware.map(
        (file, middlewareIndex) =>
          `import route${index}Middleware${middlewareIndex} from ${JSON.stringify(
            generatedImport(config.root, file),
          )};`,
      ),
    ]),
  ];
  const rpcRegistrations = routes.flatMap((route, index) =>
    route.methods.map(
      (method) =>
        `  .${method.toLowerCase()}(${JSON.stringify(route.path)}, ${middlewareSpreads(
          route,
          index,
        )}...route${index}${method})`,
    ),
  );

  return {
    entry: [
      ...imports,
      ...registrations,
      "export default app;",
      "export { app };",
      "export const fetch = app.fetch;",
    ].join("\n"),
    rpc: [
      ...rpcImports,
      "",
      `const routes = new Hono<ProjectEnv>()${rpcRegistrations.length ? "\n" : ""}${rpcRegistrations.join("\n")};`,
      "",
      "export type AppType = typeof routes;",
      "export default routes;",
      "",
    ].join("\n"),
    project: [
      `import type app from ${JSON.stringify(generatedImport(config.root, appFile))};`,
      "",
      'declare module "daroyan/app" {',
      "  interface DaroyanProject {",
      "    readonly app: typeof app;",
      "  }",
      "}",
      "",
    ].join("\n"),
  };
}

async function writeGeneratedTypes(
  root: string,
  rpcSource: string,
  projectSource: string,
): Promise<void> {
  const outputDirectory = resolve(root, ".daroyan");
  const typesDirectory = resolve(outputDirectory, "types");

  await mkdir(typesDirectory, { recursive: true });
  await writeFile(resolve(outputDirectory, "rpc.ts"), rpcSource);
  await writeFile(resolve(outputDirectory, "daroyan.d.ts"), projectSource);
  await writeFile(
    resolve(typesDirectory, "entry.d.ts"),
    [
      'import type { AppType } from "../rpc.ts";',
      "",
      "declare const app: AppType;",
      "",
      "export default app;",
      "export { app };",
      "export declare const fetch: typeof app.fetch;",
      "export type { AppType };",
      "",
    ].join("\n"),
  );
}

async function discoverRoutes(routesDirectory: string): Promise<Route[]> {
  const entries = await readdir(routesDirectory, {
    recursive: true,
    withFileTypes: true,
  });
  const routes: Route[] = [];
  const middleware = entries
    .filter((entry) => entry.isFile() && entry.name === "_middleware.ts")
    .map((entry) => resolve(entry.parentPath, entry.name));

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) {
      continue;
    }

    const file = resolve(entry.parentPath, entry.name);
    const methods = await readRouteMethods(file);

    if (methods.length === 0) {
      continue;
    }

    routes.push({
      file,
      methods,
      middleware: middleware
        .filter((middlewareFile) => isWithin(dirname(middlewareFile), file))
        .sort((left, right) => left.length - right.length),
      path: routePath(routesDirectory, file),
    });
  }

  return routes.sort((left, right) => left.path.localeCompare(right.path));
}

function isWithin(directory: string, file: string): boolean {
  const path = relative(directory, file);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`);
}

async function readRouteMethods(file: string): Promise<Route["methods"]> {
  const source = await readFile(file, "utf8");
  const ast = parseAst(source, { lang: "ts" });
  const exports = new Set<string>();

  for (const statement of ast.body) {
    if (statement.type !== "ExportNamedDeclaration" || !statement.declaration) {
      continue;
    }

    if (statement.declaration.type === "VariableDeclaration") {
      for (const declaration of statement.declaration.declarations) {
        if (declaration.id.type === "Identifier") {
          exports.add(declaration.id.name);
        }
      }
    }
  }

  return HTTP_METHODS.filter((method) => exports.has(method));
}

function routePath(routesDirectory: string, file: string): string {
  const relativeFile = relative(routesDirectory, file).split(sep).join("/");
  const segments = relativeFile.replace(/\.[^.]+$/, "").split("/");

  if (segments.at(-1) === "index") {
    segments.pop();
  }

  const path = segments.map(routeSegment).join("/");
  return path ? `/${path}` : "/";
}

function routeSegment(segment: string): string {
  if (segment.startsWith("$...")) {
    return `:${segment.slice(4)}{.+}`;
  }

  if (segment.startsWith("$")) {
    return `:${segment.slice(1)}`;
  }

  return segment;
}

function toVitePath(path: string): string {
  return path.split(sep).join("/");
}

function generatedImport(root: string, file: string): string {
  const path = relative(resolve(root, ".daroyan"), file).split(sep).join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

function middlewareSpreads(route: Route, routeIndex: number): string {
  return route.middleware
    .map((_, middlewareIndex) => `...route${routeIndex}Middleware${middlewareIndex}, `)
    .join("");
}
