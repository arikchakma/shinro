import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { ResolvedConfig } from "vite-plus";
import { GENERATED_NOTICE } from "../constants.ts";
import { validateAppModule } from "./app-module.ts";
import {
  companionFile,
  generatedImport,
  normalizeBasePath,
  toProjectPath,
  toVitePath,
  withBasePath,
} from "./paths.ts";
import { discoverRoutes, type Route, validateRoutes } from "./scanner.ts";
import type { DaroyanOptions } from "./plugin.ts";

export type GeneratedSources = {
  app: string;
  client: string;
  companions: Array<{ file: string; source: string }>;
  entry: string;
  manifest: string;
  project: string;
  rpc: string;
};

export async function createSources(
  config: ResolvedConfig,
  options: DaroyanOptions,
  outputDirectory: string,
): Promise<GeneratedSources> {
  const appFile = resolve(config.root, options.app ?? "app/app.ts");
  const routesDirectory = resolve(config.root, options.routes ?? "app/routes");
  const basePath = normalizeBasePath(options.basePath ?? "/");
  try {
    await access(appFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `[daroyan] App module not found: ${appFile}\nCreate it with a default defineApp() export or configure daroyan({ app: "path/to/app.ts" }).`,
        { cause: error },
      );
    }
    throw error;
  }
  const appAnalysis = await validateAppModule(appFile);
  const discovered = await discoverRoutes(routesDirectory, {
    ignoredRouteFiles: options.ignoredRouteFiles,
    warn: (message) => config.logger.warn(message),
  });
  const routes = discovered.routes.map((route) => ({
    ...route,
    path: withBasePath(basePath, route.path),
  }));
  const directoryMiddleware = discovered.middleware.map((middleware) => ({
    ...middleware,
    path: withBasePath(basePath, middleware.path),
  }));
  validateRoutes(routes, config.root);

  if (appAnalysis.hasEarlyResponseMiddleware && routes.length > 0) {
    config.logger.warn(
      `[daroyan] ${toProjectPath(
        config.root,
        appFile,
      )} contains base-app middleware with an early response. It runs at runtime, but every file-route RPC contract is missing that response.`,
    );
  }

  for (const route of routes) {
    if (route.kind === "sub-router" && route.middleware.length > 0) {
      config.logger.warn(
        `[daroyan] ${toProjectPath(
          config.root,
          route.file,
        )} is a default sub-router surrounded by directory middleware. The middleware runs at runtime, but its early responses cannot be added to every internal RPC response contract.`,
      );
    }
  }

  const imports = [
    ...(routes.some((route) => route.kind === "sub-router" && route.middleware.length > 0)
      ? ['import { Hono } from "hono";']
      : []),
    `import app from ${JSON.stringify(toVitePath(appFile))};`,
    ...routes.map((route, index) =>
      route.kind === "sub-router"
        ? `import route${index}Default from ${JSON.stringify(toVitePath(route.file))};`
        : `import * as route${index} from ${JSON.stringify(toVitePath(route.file))};`,
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

  const registrations = routes.flatMap((route, index) => {
    if (route.kind === "sub-router") {
      if (route.middleware.length === 0) {
        return `app.route(${JSON.stringify(route.path)}, route${index}Default);`;
      }

      return [
        `const route${index}Mounted = new Hono().use("*", ${middlewareSpreads(route, index).replace(/, $/, "")}).route("/", route${index}Default);`,
        `app.route(${JSON.stringify(route.path)}, route${index}Mounted);`,
      ];
    }

    return route.methods.map(
      (method) =>
        `app.on(${JSON.stringify(method)}, ${JSON.stringify(route.path)}, ${middlewareSpreads(
          route,
          index,
        )}...route${index}.${method});`,
    );
  });

  const rpcImports = [
    'import { Hono } from "hono";',
    'import type { ProjectEnv } from "daroyan/app";',
    `import configuredApp from ${JSON.stringify(generatedImport(outputDirectory, appFile))};`,
    ...routes.flatMap((route, index) => [
      ...(route.kind === "sub-router"
        ? [
            `import route${index}Default from ${JSON.stringify(
              generatedImport(outputDirectory, route.file),
            )};`,
          ]
        : []),
      ...route.methods.map(
        (method) =>
          `import { ${method} as route${index}${method} } from ${JSON.stringify(
            generatedImport(outputDirectory, route.file),
          )};`,
      ),
      ...(route.kind === "methods"
        ? route.middleware.map(
            (file, middlewareIndex) =>
              `import route${index}Middleware${middlewareIndex} from ${JSON.stringify(
                generatedImport(outputDirectory, file),
              )};`,
          )
        : []),
    ]),
  ];
  const rpcRegistrations = routes.flatMap((route, index) => {
    if (route.kind === "sub-router") {
      return `  .route(${JSON.stringify(route.path)}, route${index}Default)`;
    }

    return route.methods.map(
      (method) =>
        `  .${method.toLowerCase()}(${JSON.stringify(route.path)}, ${middlewareSpreads(
          route,
          index,
        )}...route${index}${method})`,
    );
  });

  return {
    app: [
      GENERATED_NOTICE,
      `import type configuredApp from ${JSON.stringify(
        generatedImport(resolve(outputDirectory, "types"), appFile),
      )};`,
      'import type { Hono } from "hono";',
      "",
      "export type App = typeof configuredApp;",
      "export type AppEnv = App extends Hono<infer Env, any, any> ? Env : never;",
      "",
    ].join("\n"),
    client: [
      GENERATED_NOTICE,
      'import type { AppType } from "./rpc.ts";',
      'import { hc } from "hono/client";',
      "",
      'const typedClient = hc<AppType>("");',
      "",
      "export type Client = typeof typedClient;",
      "export type { AppType };",
      "",
      "export const createClient = (...args: Parameters<typeof hc>): Client =>",
      "  hc<AppType>(...args);",
      "",
      'export type { InferRequestType, InferResponseType } from "hono/client";',
      "",
    ].join("\n"),
    companions: [
      ...routes.map((route) => ({
        file: companionFile(config.root, outputDirectory, route.file),
        source: [
          GENERATED_NOTICE,
          'import type { DaroyanRoute, ProjectEnv } from "daroyan/app";',
          "",
          "export type Route = DaroyanRoute<{",
          `  path: ${JSON.stringify(route.path)};`,
          `  params: ${routeParamsSource(route.path)};`,
          "  env: ProjectEnv;",
          "}>;",
          "",
        ].join("\n"),
      })),
      ...directoryMiddleware.map((middleware) => ({
        file: companionFile(config.root, outputDirectory, middleware.file),
        source: [
          GENERATED_NOTICE,
          'import type { DaroyanMiddleware, ProjectEnv } from "daroyan/app";',
          "",
          "export type Middleware = DaroyanMiddleware<{",
          `  path: ${JSON.stringify(middleware.path)};`,
          "  env: ProjectEnv;",
          "}>;",
          "",
        ].join("\n"),
      })),
    ],
    entry: [
      GENERATED_NOTICE,
      ...imports,
      ...registrations,
      "export default app;",
      "export { app };",
      "export const fetch = app.fetch;",
    ].join("\n"),
    manifest: `${JSON.stringify(
      {
        _notice: "Generated by Daroyan (format 1). Do not edit.",
        version: 1,
        basePath,
        routes: routes.map((route) => ({
          kind: route.kind,
          file: toProjectPath(config.root, route.file),
          ...(route.kind === "methods"
            ? { path: route.path, methods: route.methods }
            : { mountPath: route.path }),
          middleware: route.middleware.map((file) => toProjectPath(config.root, file)),
        })),
      },
      undefined,
      2,
    )}\n`,
    rpc: [
      GENERATED_NOTICE,
      ...rpcImports,
      "",
      `const routes = new Hono<ProjectEnv>()`,
      `  .route("/", configuredApp)${rpcRegistrations.length ? "\n" : ";"}${rpcRegistrations.join("\n")}${rpcRegistrations.length ? ";" : ""}`,
      "",
      "export type AppType = typeof routes;",
      "export default routes;",
      "",
    ].join("\n"),
    project: [
      GENERATED_NOTICE,
      `import type app from ${JSON.stringify(generatedImport(outputDirectory, appFile))};`,
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

function middlewareSpreads(route: Route, routeIndex: number): string {
  return route.middleware
    .map((_, middlewareIndex) => `...route${routeIndex}Middleware${middlewareIndex}, `)
    .join("");
}

function routeParamsSource(path: string): string {
  const params = [...path.matchAll(/:([^/{}]+)(?:\{\.\+\})?/g)].map((match) => match[1]);

  if (params.length === 0) {
    return "Record<never, never>";
  }

  return `{ ${params.map((param) => `${JSON.stringify(param)}: string`).join("; ")} }`;
}
