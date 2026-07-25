import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ResolvedConfig } from 'vite-plus';

import {
  CLIENT_FILE,
  CLIENT_ID,
  GENERATED_NOTICE,
  ROUTES_FILE,
  ROUTES_ID,
  RPC_ID,
} from '../constants.ts';
import { validateAppModule } from './app.ts';
import {
  companionFile,
  generatedImport,
  normalizeBasePath,
  routeParameterNames,
  toProjectPath,
  withBasePath,
} from './path.ts';
import type { DaroyanOptions } from './plugin.ts';
import { discoverRoutes, validateRoutes } from './scanner.ts';
import type { Route } from './scanner.ts';

export type GeneratedSources = {
  client: string;
  companions: Array<{ file: string; source: string }>;
  manifest: string;
  modules: string;
  routes: string;
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
  const rpcEnabled = options.rpc?.enabled !== false;
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
  validateRoutes(routes, config.root, routesDirectory);

  if (appAnalysis.hasEarlyResponseMiddleware && routes.length > 0) {
    config.logger.warn(
      `[daroyan] ${toProjectPath(
        config.root,
        appFile
      )} contains base-app middleware with an early response. It runs at runtime, but every file-route RPC contract is missing that response.`
    );
  }

  // The application owns the mount now, which makes two mistakes possible that
  // the previous generated entry prevented structurally: never mounting, and
  // mounting before the middleware that is supposed to wrap the mounted routes.
  // Both leave a working app that quietly serves the wrong thing.
  if (!appAnalysis.mountsRoutes && routes.length > 0) {
    config.logger.warn(
      `[daroyan] ${toProjectPath(config.root, appFile)} never mounts ${ROUTES_ID}, so ${
        routes.length
      } file ${routes.length === 1 ? 'route is' : 'routes are'} not served.\nAdd .route("/", routes()) to the app, after any global middleware.`
    );
  }

  if (appAnalysis.registersMiddlewareAfterMount && routes.length > 0) {
    config.logger.warn(
      `[daroyan] ${toProjectPath(
        config.root,
        appFile
      )} registers middleware after .route("/", routes()). Hono composes handlers in registration order, so that middleware never runs for a file route. Move the mount below your global middleware.`
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

  const routerImports = [
    'import { Hono } from "hono";',
    'import type { ProjectEnv } from "daroyan/app";',
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
  // router's complete RPC contract.
  const subRouterMounts = routes.flatMap((route, index) =>
    route.kind === 'sub-router' && route.middleware.length > 0
      ? [
          `  const route${index}Mounted = new Hono<ProjectEnv>()`,
          `    .use("*", ${middlewareSpreads(route, index).join(', ')})`,
          `    .route("/", route${index}Default);`,
        ]
      : []
  );

  const registrations = routes.flatMap((route, index) => {
    if (route.kind === 'sub-router') {
      const mounted =
        route.middleware.length > 0
          ? `route${index}Mounted`
          : `route${index}Default`;
      return `    .route(${JSON.stringify(route.path)}, ${mounted})`;
    }

    return route.methods.map((method) =>
      [
        `    .${method.toLowerCase()}(`,
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
    // The client is the only generated module that reaches for the application,
    // and it does so as a type: `AppType` is whatever the app module exports, so
    // manual routes and file routes are both in it without codegen assembling
    // anything.
    client: [
      GENERATED_NOTICE,
      'import { hc } from "hono/client";',
      '',
      `import type app from ${JSON.stringify(
        generatedImport(outputDirectory, appFile)
      )};`,
      '',
      'type AppType = typeof app;',
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
    // A standalone sub-router, mounted by the application rather than wrapped
    // around it. Nothing here imports the app, which is what lets the app import
    // this. Built on `ProjectEnv` so the handlers route files export line up
    // with the router they register on; `route()` leaves the sub-environment
    // unconstrained relative to the parent's, so it still mounts onto whatever
    // app the user assembled.
    //
    // Deliberately no `onError` on this instance: Hono's `route()` wraps every
    // copied handler in a compose closure when the sub-app carries its own error
    // handler, so error handling belongs on the application.
    routes: [
      GENERATED_NOTICE,
      ...routerImports,
      '',
      'export function routes() {',
      ...subRouterMounts,
      ...(subRouterMounts.length > 0 ? [''] : []),
      ...(registrations.length > 0
        ? ['  return new Hono<ProjectEnv>()', ...registrations].map(
            (line, index, lines) =>
              index === lines.length - 1 ? `${line};` : line
          )
        : ['  return new Hono<ProjectEnv>();']),
      '}',
      '',
      'export type Routes = ReturnType<typeof routes>;',
      '',
    ].join('\n'),
    // Generated files are an implementation detail, so nothing in the user's
    // source reaches into the generated directory by path. These declarations are
    // the only way in, and they stay stable when `rpc.outDir` moves. Each one
    // indirects through the real file via `import(...)`, which is what keeps the
    // chained route schema intact.
    modules: [
      GENERATED_NOTICE,
      `declare module "${ROUTES_ID}" {`,
      `  export const routes: typeof import("./${ROUTES_FILE}").routes;`,
      `  export type Routes = import("./${ROUTES_FILE}").Routes;`,
      '}',
      ...(rpcEnabled
        ? [
            '',
            `declare module "${CLIENT_ID}" {`,
            `  export const createClient: typeof import("./${CLIENT_FILE}").createClient;`,
            `  export type Client = import("./${CLIENT_FILE}").Client;`,
            `  export type AppType = import("./${CLIENT_FILE}").AppType;`,
            '  export type { InferRequestType, InferResponseType } from "hono/client";',
            '}',
            '',
            `declare module "${RPC_ID}" {`,
            `  export type AppType = import("./${CLIENT_FILE}").AppType;`,
            '}',
          ]
        : []),
      '',
    ].join('\n'),
    manifest: `${JSON.stringify(
      {
        _notice: 'Generated by Daroyan (format 2). Do not edit.',
        version: 2,
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
    // `rpc.ts` stays part of the published surface for workspaces that expose
    // their contract to other packages. It is types only: re-exporting a runtime
    // app from here would pull the whole server into every consumer of `./rpc`.
    rpc: [
      GENERATED_NOTICE,
      `export type { AppType } from "./${CLIENT_FILE}";`,
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
  const params = routeParameterNames(path);

  if (params.length === 0) {
    return 'Record<never, never>';
  }

  return `{ ${params.map((param) => `${JSON.stringify(param)}: string`).join('; ')} }`;
}
