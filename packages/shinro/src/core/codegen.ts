import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ResolvedShinroConfig } from '../config.ts';
import {
  CLIENT_FILE,
  GENERATED_FORMAT,
  GENERATED_NOTICE,
  HONO_HANDLER_LIMIT,
  MANIFEST_FILE,
  ROUTES_FILE,
  ROUTES_SPECIFIER,
} from '../constants.ts';
import { validateAppModule } from './app.ts';
import type { ShinroLogger } from './logger.ts';
import {
  generatedSpecifier,
  getTypeDeclarationPath,
  routeParameterNames,
  toProjectPath,
} from './path.ts';
import { discoverRoutes, validateRoutes } from './scanner.ts';
import type { DirectoryMiddleware, Route } from './scanner.ts';

/**
 * Absolute path to contents, in the order they should be promoted. Codegen never
 * touches the filesystem beyond reading sources: what it returns is the complete
 * generation, which is what makes `--check` a byte comparison rather than a
 * second implementation.
 */
export type GeneratedFiles = Map<string, string>;

export async function generateSources(options: {
  config: ResolvedShinroConfig;
  logger: ShinroLogger;
}): Promise<GeneratedFiles> {
  const { config, logger } = options;
  const appFile = resolve(config.root, config.app);
  const routesDirectory = resolve(config.root, config.routes);
  const { outputDirectory, root } = config;

  try {
    await access(appFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `[shinro] App module not found: ${appFile}\nCreate it with a default defineApp() export or set "app" in shinro.config.json.`,
        { cause: error }
      );
    }
    throw error;
  }

  const appAnalysis = await validateAppModule(appFile);
  const { middleware, routes } = await discoverRoutes(routesDirectory, {
    ignoredRouteFiles: config.ignoredRouteFiles,
    warn: (message) => logger.warn(message),
  });
  validateRoutes(routes, root, routesDirectory);
  const middlewarePlan = planMiddleware(routes, middleware, root);
  for (const warning of middlewarePlan.warnings) {
    logger.warn(warning);
  }

  if (appAnalysis.hasEarlyResponseMiddleware && routes.length > 0) {
    logger.warn(
      `[shinro] ${toProjectPath(
        root,
        appFile
      )} contains base-app middleware with an early response. It runs at runtime, but every file-route RPC contract is missing that response.`
    );
  }

  // The application owns the mount now, which makes two mistakes possible that
  // the previous generated entry prevented structurally: never mounting, and
  // mounting before the middleware that is supposed to wrap the mounted routes.
  // Both leave a working app that quietly serves the wrong thing.
  if (!appAnalysis.mountsRoutes && routes.length > 0) {
    logger.warn(
      `[shinro] ${toProjectPath(root, appFile)} never mounts ${ROUTES_SPECIFIER}, so ${
        routes.length
      } file ${routes.length === 1 ? 'route is' : 'routes are'} not served.\nAdd .route("/", routes()) to the app, after any global middleware.`
    );
  }

  if (appAnalysis.registersMiddlewareAfterMount && routes.length > 0) {
    logger.warn(
      `[shinro] ${toProjectPath(
        root,
        appFile
      )} registers middleware after .route("/", routes()). Hono composes handlers in registration order, so that middleware never runs for a file route. Move the mount below your global middleware.`
    );
  }

  for (const route of routes) {
    if (route.kind === 'sub-router' && route.middleware.length > 0) {
      logger.warn(
        `[shinro] ${toProjectPath(
          root,
          route.file
        )} is a default sub-router surrounded by directory middleware. The middleware runs at runtime, but its early responses cannot be added to every internal RPC response contract.`
      );
    }
  }

  // One local name per middleware file rather than per route that uses it. The
  // deep case — three nested `_middleware.ts` shared by a dozen routes — would
  // otherwise import the same module a dozen times under a dozen names.
  const middlewareNames = new Map(
    middleware.map((entry, index) => [entry.file, `middleware${index}`])
  );

  return new Map([
    [
      resolve(outputDirectory, ROUTES_FILE),
      routesModule({
        compose: middlewarePlan.compose,
        middlewareNames,
        outputDirectory,
        routes,
      }),
    ],
    ...typeDeclarations({
      middleware,
      outputDirectory,
      root,
      routes,
      routesDirectory,
    }),
    [
      resolve(outputDirectory, CLIENT_FILE),
      clientModule(outputDirectory, appFile),
    ],
    // `manifest.json` is written last so it doubles as the commit marker: once a
    // reader observes a new manifest, every other generated file it describes is
    // already in place.
    [resolve(outputDirectory, MANIFEST_FILE), manifest(root, routes)],
  ]);
}

/**
 * Which routes have to compose their directory middleware into a single
 * `every()` slot, and which cannot be made to fit at all.
 *
 * Hono's typed overloads end at path plus ten handlers. The variadic fallback
 * past that infers one shared `Input` for the whole chain, so the generated
 * client loses every validator's contract — and the arity is a property of the
 * emitted registration, which makes generate the only step that can see it.
 *
 * Inlining every middleware in its own slot is the default because it is the
 * higher-fidelity emit: a `defineMiddleware` element keeps its own return type,
 * so a middleware that short-circuits with `c.json(..., 401)` puts that 401 in
 * the route's client contract. `every()` returns a plain `MiddlewareHandler`,
 * which erases that. So composition is a remedy applied per route, not a style:
 * it trades one route's middleware responses for the validator contract of the
 * whole chain, and only where the alternative is losing both.
 */
function planMiddleware(
  routes: Route[],
  middleware: DirectoryMiddleware[],
  root: string
): { compose: Set<Route>; warnings: string[] } {
  const compose = new Set<Route>();
  const warnings: string[] = [];
  const offenders: string[] = [];
  // Tuple lengths, not file counts: inlining spreads each `defineMiddleware`
  // tuple, so three middleware in one file cost three slots. An unknown length —
  // a spread inside the tuple — counts as one, the best case, because rejecting
  // working code over a number nobody can read is worse than the loud overload
  // error TypeScript raises if the guess is wrong.
  const slotsPerFile = new Map(
    middleware.map((entry) => [entry.file, entry.count ?? 1])
  );
  const middlewareSlots = (route: Route): number =>
    route.middleware.reduce(
      (total, file) => total + (slotsPerFile.get(file) ?? 1),
      0
    );

  for (const route of routes) {
    if (route.kind === 'sub-router') {
      continue;
    }

    // The widest method decides for the whole route: one registration per method,
    // but one emitted middleware form per route keeps `routes.ts` readable.
    const arities = route.methods
      .map((method) => route.arities[method])
      .filter((arity): arity is number => typeof arity === 'number');
    const widest = Math.max(0, ...arities);
    const inlined = widest + middlewareSlots(route);
    if (inlined <= HONO_HANDLER_LIMIT) {
      continue;
    }

    if (middlewareSlots(route) > 1 && widest + 1 <= HONO_HANDLER_LIMIT) {
      compose.add(route);
      warnings.push(
        `[shinro] ${toProjectPath(
          root,
          route.file
        )} reaches ${inlined} handlers once its directory middleware are inlined, over Hono's typed limit of ${HONO_HANDLER_LIMIT}. They are composed into one slot with every() so the route keeps its validated request and response types — but an early response from those middleware is no longer part of this route's client contract.`
      );
      continue;
    }

    const method = route.methods.find(
      (candidate) => route.arities[candidate] === widest
    );
    offenders.push(
      [
        `- ${method ?? 'GET'} ${route.path} (${widest + Math.min(middlewareSlots(route), 1)} handlers)`,
        `  ${toProjectPath(root, route.file)}: ${widest} in the defineHandler tuple`,
        ...(route.middleware.length > 0
          ? [
              `  ${route.middleware
                .map((file) => toProjectPath(root, file))
                .join(', ')}: 1 slot once composed`,
            ]
          : []),
      ].join('\n')
    );
  }

  if (offenders.length > 0) {
    throw new Error(
      [
        `[shinro] Too many handlers for Hono's typed overloads (limit ${HONO_HANDLER_LIMIT}):`,
        ...offenders,
        `Past the limit Hono falls back to a variadic signature that infers one shared input for the whole chain, so the generated client loses every validator's contract without a single diagnostic. Move work out of the defineHandler tuple, or into a "_middleware.ts", which can be composed into one slot.`,
      ].join('\n')
    );
  }

  return { compose, warnings };
}

/**
 * A standalone sub-router, mounted by the application rather than wrapped around
 * it. Nothing here imports the app, which is what lets the app import this.
 *
 * Deliberately no `onError` on this instance: Hono's `route()` wraps every copied
 * handler in a compose closure when the sub-app carries its own error handler, so
 * error handling belongs on the application.
 */
function routesModule(options: {
  compose: Set<Route>;
  middlewareNames: Map<string, string>;
  outputDirectory: string;
  routes: Route[];
}): string {
  const { compose, middlewareNames, outputDirectory, routes } = options;
  const usedMiddleware = [...middlewareNames].filter(([file]) =>
    routes.some((route) => route.middleware.includes(file))
  );
  const spread = (route: Route): string[] =>
    route.middleware.map((file) => `...${middlewareNames.get(file)}`);
  /**
   * One slot for the whole directory chain, used only where inlining would push
   * the registration past Hono's typed overloads. `every()` erases the
   * middleware's own response types, so it buys the validator contract at the
   * price of the middleware's early responses — worth it only when the
   * alternative is losing both.
   */
  const middlewareArguments = (route: Route): string[] =>
    compose.has(route) ? [`every(${spread(route).join(', ')})`] : spread(route);

  const imports = [
    'import { Hono } from "hono";',
    // Runtime-neutral: `hono/combine` is not a `node:` specifier.
    ...(compose.size > 0 ? ['import { every } from "hono/combine";'] : []),
    'import type { ProjectEnv } from "shinro/app";',
    ...usedMiddleware.map(
      ([file, name]) =>
        `import ${name} from ${JSON.stringify(
          generatedSpecifier(outputDirectory, file)
        )};`
    ),
    ...routes.flatMap((route, index) => [
      ...(route.kind === 'sub-router'
        ? [
            `import route${index}Default from ${JSON.stringify(
              generatedSpecifier(outputDirectory, route.file)
            )};`,
          ]
        : []),
      ...route.methods.map(
        (method) =>
          `import { ${method} as route${index}${method} } from ${JSON.stringify(
            generatedSpecifier(outputDirectory, route.file)
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
          `    .use("*", ${spread(route).join(', ')})`,
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
          ...middlewareArguments(route),
          `...route${index}${method}`,
        ].join(', '),
        ')',
      ].join('')
    );
  });

  return [
    GENERATED_NOTICE,
    ...imports,
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
  ].join('\n');
}

/**
 * The only generated module that reaches for the application, and it does so as a
 * type: `AppType` is whatever the app module exports, so manual routes and file
 * routes are both in it without codegen assembling anything.
 *
 * Consumers elaborate this chained type themselves, which is the DX cliff on a
 * large app — `tsc --declaration` over this file flattens the chain and is the
 * documented answer for anything past a few dozen routes.
 */
function clientModule(outputDirectory: string, appFile: string): string {
  return [
    GENERATED_NOTICE,
    'import { hc } from "hono/client";',
    '',
    `import type app from ${JSON.stringify(
      generatedSpecifier(outputDirectory, appFile)
    )};`,
    '',
    'type AppType = typeof app;',
    '',
    'const typedClient = hc<AppType>("");',
    '',
    'export type Client = typeof typedClient;',
    'export type { AppType };',
    '',
    'export const defineClient = (...args: Parameters<typeof hc>): Client =>',
    '  hc<AppType>(...args);',
    '',
    'export type { InferRequestType, InferResponseType } from "hono/client";',
    '',
  ].join('\n');
}

function typeDeclarations(options: {
  middleware: DirectoryMiddleware[];
  outputDirectory: string;
  root: string;
  routes: Route[];
  routesDirectory: string;
}): Array<[string, string]> {
  const { middleware, outputDirectory, root, routes, routesDirectory } =
    options;
  const declarationPath = (file: string): string =>
    getTypeDeclarationPath(root, routesDirectory, outputDirectory, file);

  return [
    ...routes.map((route): [string, string] => [
      declarationPath(route.file),
      [
        GENERATED_NOTICE,
        'import type { ShinroRoute, ProjectEnv } from "shinro/app";',
        '',
        'export namespace Route {',
        '  export type Handler = ShinroRoute<{',
        `    path: ${JSON.stringify(route.path)};`,
        `    params: ${routeParamsType(route.path)};`,
        '    env: ProjectEnv;',
        '  }>;',
        '}',
        '',
      ].join('\n'),
    ]),
    ...middleware.map((entry): [string, string] => [
      declarationPath(entry.file),
      [
        GENERATED_NOTICE,
        'import type { ShinroMiddleware, ProjectEnv } from "shinro/app";',
        '',
        'export namespace Route {',
        '  export type Middleware = ShinroMiddleware<{',
        `    path: ${JSON.stringify(entry.path)};`,
        '    env: ProjectEnv;',
        '  }>;',
        '}',
        '',
      ].join('\n'),
    ]),
  ];
}

function manifest(root: string, routes: Route[]): string {
  return `${JSON.stringify(
    {
      _notice: `Generated by Shinro (format ${GENERATED_FORMAT}). Do not edit.`,
      format: GENERATED_FORMAT,
      routes: routes.map((route) => ({
        kind: route.kind,
        file: toProjectPath(root, route.file),
        ...(route.kind === 'methods'
          ? { path: route.path, methods: route.methods }
          : { mountPath: route.path }),
        middleware: route.middleware.map((file) => toProjectPath(root, file)),
      })),
    },
    undefined,
    2
  )}\n`;
}

function routeParamsType(path: string): string {
  const params = routeParameterNames(path);

  if (params.length === 0) {
    return 'Record<never, never>';
  }

  return `{ ${params.map((param) => `${JSON.stringify(param)}: string`).join('; ')} }`;
}
