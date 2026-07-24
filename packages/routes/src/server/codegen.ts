import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ResolvedConfig } from 'vite-plus';

import { GENERATED_NOTICE } from '../constants.ts';
import { validateAppModule } from './app.ts';
import {
  companionFile,
  generatedImport,
  normalizeBasePath,
  toProjectPath,
  withBasePath,
} from './path.ts';
import type { DaroyanOptions } from './plugin.ts';
import { discoverRoutes, validateRoutes } from './scanner.ts';
import type { Route } from './scanner.ts';

export type GeneratedSources = {
  app: string;
  client: string;
  companions: Array<{ file: string; source: string }>;
  entry: string;
  entryTypes: string;
  manifest: string;
  project: string;
  rpc: string;
};

export async function createSources(
  config: ResolvedConfig,
  options: DaroyanOptions,
  outputDirectory: string
): Promise<GeneratedSources> {
  const appFile = resolve(config.root, options.app ?? 'src/app.ts');
  const routesDirectory = resolve(config.root, options.routes ?? 'src/routes');
  const basePath = normalizeBasePath(options.basePath ?? '/');
  try {
    await access(appFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `[daroyan] App module not found: ${appFile}\nCreate it with a default defineApp() export or configure daroyan({ app: "path/to/app.ts" }).`,
        { cause: error }
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
        appFile
      )} contains base-app middleware with an early response. It runs at runtime, but every file-route RPC contract is missing that response.`
    );
  }

  for (const route of routes) {
    if (route.kind === 'sub-router' && route.middleware.length > 0) {
      config.logger.warn(
        `[daroyan] ${toProjectPath(
          config.root,
          route.file
        )} is a default sub-router surrounded by directory middleware. The middleware runs at runtime, but its early responses cannot be added to every internal RPC response contract.`
      );
    }
  }

  const mountsSubRouterMiddleware = routes.some(
    (route) => route.kind === 'sub-router' && route.middleware.length > 0
  );
  const entryImports = [
    ...(mountsSubRouterMiddleware ? ['import { Hono } from "hono";'] : []),
    'import type { ProjectEnv } from "daroyan/app";',
    `import app from ${JSON.stringify(generatedImport(outputDirectory, appFile))};`,
    ...routes.flatMap((route, index) => [
      ...(route.kind === 'sub-router'
        ? [
            `import route${index}Default from ${JSON.stringify(
              generatedImport(outputDirectory, route.file)
            )};`,
          ]
        : []),
      ...route.methods.map(
        (method) =>
          `import { ${method} as route${index}${method} } from ${JSON.stringify(
            generatedImport(outputDirectory, route.file)
          )};`
      ),
      ...route.middleware.map(
        (file, middlewareIndex) =>
          `import route${index}Middleware${middlewareIndex} from ${JSON.stringify(
            generatedImport(outputDirectory, file)
          )};`
      ),
    ]),
  ];

  // Sub-routers that carry directory middleware are wrapped once, before the
  // chain, so the chain itself stays a single expression whose type is the
  // application's complete RPC contract.
  const subRouterMounts = routes.flatMap((route, index) =>
    route.kind === 'sub-router' && route.middleware.length > 0
      ? [
          `const route${index}Mounted = new Hono<ProjectEnv>()`,
          `  .use("*", ${middlewareSpreads(route, index).join(', ')})`,
          `  .route("/", route${index}Default);`,
        ]
      : []
  );

  const registrations = routes.flatMap((route, index) => {
    if (route.kind === 'sub-router') {
      const mounted =
        route.middleware.length > 0
          ? `route${index}Mounted`
          : `route${index}Default`;
      return `  .route(${JSON.stringify(route.path)}, ${mounted})`;
    }

    return route.methods.map((method) =>
      [
        `  .${method.toLowerCase()}(`,
        [
          JSON.stringify(route.path),
          ...middlewareSpreads(route, index),
          `...route${index}${method}`,
        ].join(', '),
        ')',
      ].join('')
    );
  });

  return {
    app: [
      GENERATED_NOTICE,
      `import type configuredApp from ${JSON.stringify(
        generatedImport(resolve(outputDirectory, 'types'), appFile)
      )};`,
      'import type { Hono } from "hono";',
      '',
      'export type App = typeof configuredApp;',
      'export type AppEnv = App extends Hono<infer Env, any, any> ? Env : never;',
      '',
    ].join('\n'),
    client: [
      GENERATED_NOTICE,
      'import type { AppType } from "./rpc.ts";',
      'import { hc } from "hono/client";',
      '',
      'const typedClient = hc<AppType>("");',
      '',
      'export type Client = typeof typedClient;',
      'export type { AppType };',
      '',
      'export const createClient = (...args: Parameters<typeof hc>): Client =>',
      '  hc<AppType>(...args);',
      '',
      'export type { InferRequestType, InferResponseType } from "hono/client";',
      '',
    ].join('\n'),
    companions: [
      ...routes.map((route) => ({
        file: companionFile(config.root, outputDirectory, route.file),
        source: [
          GENERATED_NOTICE,
          'import type { DaroyanRoute, ProjectEnv } from "daroyan/app";',
          '',
          'export namespace Route {',
          '  export type Handler = DaroyanRoute<{',
          `    path: ${JSON.stringify(route.path)};`,
          `    params: ${routeParamsSource(route.path)};`,
          '    env: ProjectEnv;',
          '  }>;',
          '}',
          '',
        ].join('\n'),
      })),
      ...directoryMiddleware.map((middleware) => ({
        file: companionFile(config.root, outputDirectory, middleware.file),
        source: [
          GENERATED_NOTICE,
          'import type { DaroyanMiddleware, ProjectEnv } from "daroyan/app";',
          '',
          'export namespace Route {',
          '  export type Middleware = DaroyanMiddleware<{',
          `    path: ${JSON.stringify(middleware.path)};`,
          '    env: ProjectEnv;',
          '  }>;',
          '}',
          '',
        ].join('\n'),
      })),
    ],
    entry: [
      GENERATED_NOTICE,
      ...entryImports,
      '',
      ...subRouterMounts,
      ...(subRouterMounts.length > 0 ? [''] : []),
      // Registering onto the configured app keeps one Hono instance at runtime
      // while the chained result carries the schema Hono needs for RPC, so the
      // running application and its client type are the same artifact.
      ...(registrations.length > 0
        ? ['const routes = app', ...registrations].map((line, index, lines) =>
            index === lines.length - 1 ? `${line};` : line
          )
        : ['const routes = app;']),
      '',
      'export type AppType = typeof routes;',
      'export default routes;',
      'export { routes as app };',
      'export const fetch = routes.fetch;',
      '',
    ].join('\n'),
    entryTypes: [
      GENERATED_NOTICE,
      'declare module "daroyan/entry" {',
      '  const app: import("./entry.ts").AppType;',
      '',
      '  export default app;',
      '  export { app };',
      '  export const fetch: typeof app.fetch;',
      '  export type AppType = import("./entry.ts").AppType;',
      '}',
      '',
    ].join('\n'),
    manifest: `${JSON.stringify(
      {
        _notice: 'Generated by Daroyan (format 1). Do not edit.',
        version: 1,
        basePath,
        routes: routes.map((route) => ({
          kind: route.kind,
          file: toProjectPath(config.root, route.file),
          ...(route.kind === 'methods'
            ? { path: route.path, methods: route.methods }
            : { mountPath: route.path }),
          middleware: route.middleware.map((file) =>
            toProjectPath(config.root, file)
          ),
        })),
      },
      undefined,
      2
    )}\n`,
    // `entry.ts` is the single generated route table. `rpc.ts` stays part of the
    // published surface as a type-first alias of it.
    rpc: [
      GENERATED_NOTICE,
      'export type { AppType } from "./entry.ts";',
      'export { default } from "./entry.ts";',
      '',
    ].join('\n'),
    project: [
      GENERATED_NOTICE,
      `import type app from ${JSON.stringify(generatedImport(outputDirectory, appFile))};`,
      '',
      'declare module "daroyan/app" {',
      '  interface DaroyanProject {',
      '    readonly app: typeof app;',
      '  }',
      '}',
      '',
    ].join('\n'),
  };
}

function middlewareSpreads(route: Route, routeIndex: number): string[] {
  return route.middleware.map(
    (_, middlewareIndex) => `...route${routeIndex}Middleware${middlewareIndex}`
  );
}

function routeParamsSource(path: string): string {
  const params = [...path.matchAll(/:([^/{}]+)(?:\{\.\+\})?/g)].map(
    (match) => match[1]
  );

  if (params.length === 0) {
    return 'Record<never, never>';
  }

  return `{ ${params.map((param) => `${JSON.stringify(param)}: string`).join('; ')} }`;
}
