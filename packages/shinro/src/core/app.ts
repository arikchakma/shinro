import { readFile } from 'node:fs/promises';

import { ROUTES_FILE, ROUTES_SPECIFIER } from '../constants.ts';
import type { NodeView } from './ast.ts';
import {
  containsCallTo,
  isHonoExpression,
  isTransparentExpression,
  localNamesForImport,
  parseModule,
  specifierNames,
  toNodeView,
} from './ast.ts';

export type AppModuleAnalysis = {
  hasEarlyResponseMiddleware: boolean;
  mountsRoutes: boolean;
  registersMiddlewareAfterMount: boolean;
};

/**
 * Every spelling of the generated router that resolves at runtime. The
 * documented default is `#shinro/routes`; a relative path to the file is an
 * equally valid import that needs no package.json at all, and the bare
 * `shinro/routes` only ever worked through the Vite plugin's `resolveId`, so it
 * is recognised here to keep diagnostics honest for a project mid-migration.
 */
function isRoutesSpecifier(source: string): boolean {
  return (
    source === ROUTES_SPECIFIER ||
    source === 'shinro/routes' ||
    source.endsWith(`/${ROUTES_FILE}`)
  );
}

export async function validateAppModule(
  file: string
): Promise<AppModuleAnalysis> {
  const source = await readFile(file, 'utf8');
  const ast = parseModule(file, source, 'app module');
  const routers = localNamesForImport(ast, 'routes', isRoutesSpecifier);
  const factories = localNamesForImport(ast, 'defineApp');
  // `defineApp()` only calls `new Hono()`, so an app module that reaches for
  // Hono directly is just as valid an application root.
  const constructors = localNamesForImport(ast, 'Hono');
  const apps = new Set<string>();
  const scope: AppScope = { apps, constructors, factories };

  for (const statement of ast.body) {
    const declaration =
      statement.type === 'ExportNamedDeclaration'
        ? statement.declaration
        : statement;
    if (declaration?.type !== 'VariableDeclaration') {
      continue;
    }

    for (const variable of declaration.declarations) {
      if (
        variable.id.type === 'Identifier' &&
        isAppExpression(variable.init, scope)
      ) {
        apps.add(variable.id.name);
      }
    }
  }

  const validDefault = ast.body.some((statement) => {
    if (statement.type === 'ExportDefaultDeclaration') {
      return isAppExpression(statement.declaration, scope);
    }

    if (
      statement.type !== 'ExportNamedDeclaration' ||
      statement.source !== null
    ) {
      return false;
    }

    return statement.specifiers.some((specifier) => {
      if (specifier.type !== 'ExportSpecifier') {
        return false;
      }

      const names = specifierNames(specifier);
      return names.exported === 'default' && apps.has(names.local);
    });
  });

  if (!validDefault) {
    throw new Error(
      `[shinro] Invalid app module ${file}: default-export a Hono instance, created either by defineApp() or by new Hono().`
    );
  }

  return {
    hasEarlyResponseMiddleware: ast.body.some((statement) =>
      isEarlyResponseUseStatement(statement, apps)
    ),
    mountsRoutes: ast.body.some((statement) =>
      containsCallTo(statement, routers)
    ),
    registersMiddlewareAfterMount: registersMiddlewareAfterMount(
      ast,
      apps,
      routers
    ),
  };
}

/**
 * Hono composes handlers in registration order, so middleware registered after
 * the mount never wraps a route the mount brought in. Both spellings are
 * checked: a `use` later in the same chain as the mounting `route`, and a
 * `app.use(...)` statement after the statement that mounted.
 */
function registersMiddlewareAfterMount(
  ast: ReturnType<typeof parseModule>,
  apps: Set<string>,
  routers: Set<string>
): boolean {
  if (routers.size === 0) {
    return false;
  }

  let mounted = false;

  for (const statement of ast.body) {
    const declaration =
      statement.type === 'ExportNamedDeclaration'
        ? statement.declaration
        : statement;

    for (const chain of appChains(declaration ?? statement, routers)) {
      const mount = chain.findIndex((call) => call.mountsRoutes);
      if (
        mount !== -1 &&
        chain.slice(mount + 1).some((call) => call.name === 'use')
      ) {
        return true;
      }
    }

    if (mounted && isUseStatement(statement, apps)) {
      return true;
    }
    if (containsCallTo(statement, routers)) {
      mounted = true;
    }
  }

  return false;
}

type ChainCall = { mountsRoutes: boolean; name: string };

function appChains(value: unknown, routers: Set<string>): ChainCall[][] {
  const node = toNodeView(value);
  if (!node) {
    return [];
  }

  if (node.type === 'VariableDeclaration') {
    const { declarations } = value as {
      declarations: Array<{ init?: unknown }>;
    };
    return declarations.flatMap((variable) =>
      appChains(variable.init, routers)
    );
  }
  if (
    node.type === 'ExportDefaultDeclaration' ||
    node.type === 'ExpressionStatement'
  ) {
    return appChains(node.expression ?? node.declaration, routers);
  }
  if (isTransparentExpression(node)) {
    return appChains(node.expression, routers);
  }

  return node.type === 'CallExpression' ? [chainCalls(node, routers)] : [];
}

function chainCalls(value: unknown, routers: Set<string>): ChainCall[] {
  const node = toNodeView(value);
  if (!node) {
    return [];
  }
  if (isTransparentExpression(node)) {
    return chainCalls(node.expression, routers);
  }
  if (node.type !== 'CallExpression') {
    return [];
  }

  const callee = toNodeView(node.callee);
  if (callee?.type !== 'MemberExpression') {
    return [];
  }

  const property = toNodeView(callee.property);

  return [
    ...chainCalls(callee.object, routers),
    {
      // Decided by the argument tree rather than by the method name: only a call
      // that receives the generated router mounts it, and only its own arguments
      // can say so.
      mountsRoutes: (node.arguments ?? []).some((argument) =>
        containsCallTo(argument, routers)
      ),
      name: property?.type === 'Identifier' ? (property.name ?? '') : '',
    },
  ];
}

function isUseStatement(value: unknown, apps: Set<string>): boolean {
  const statement = toNodeView(value);
  if (statement?.type !== 'ExpressionStatement') {
    return false;
  }

  const expression = toNodeView(statement.expression);
  const callee = toNodeView(expression?.callee);
  const object = toNodeView(callee?.object);
  const property = toNodeView(callee?.property);

  return (
    expression?.type === 'CallExpression' &&
    callee?.type === 'MemberExpression' &&
    object?.type === 'Identifier' &&
    object.name !== undefined &&
    apps.has(object.name) &&
    property?.type === 'Identifier' &&
    property.name === 'use'
  );
}

type AppScope = {
  apps: Set<string>;
  constructors: Set<string>;
  factories: Set<string>;
};

// Like `isHonoExpression`, but a bare `defineApp()` call also counts as an app
// root. The chained case must recurse through here rather than delegating, so
// `defineApp().get(...).onError(...)` still resolves to the factory at its base.
function isAppExpression(value: unknown, scope: AppScope): boolean {
  const node = toNodeView(value);
  if (!node) {
    return false;
  }

  if (node.type === 'CallExpression') {
    const callee = toNodeView(node.callee);
    if (callee?.type === 'Identifier') {
      return callee.name !== undefined && scope.factories.has(callee.name);
    }
    return callee?.type === 'MemberExpression'
      ? isAppExpression(callee.object, scope)
      : false;
  }
  if (isTransparentExpression(node)) {
    return isAppExpression(node.expression, scope);
  }

  return isHonoExpression(value, scope.constructors, scope.apps);
}

function isEarlyResponseUseStatement(
  value: unknown,
  apps: Set<string>
): boolean {
  const statement = toNodeView(value);
  if (statement?.type !== 'ExpressionStatement') {
    return false;
  }

  const expression = toNodeView(statement.expression);
  if (expression?.type !== 'CallExpression') {
    return false;
  }

  const callee = toNodeView(expression.callee);
  const object = toNodeView(callee?.object);
  const property = toNodeView(callee?.property);
  if (
    callee?.type !== 'MemberExpression' ||
    object?.type !== 'Identifier' ||
    object.name === undefined ||
    !apps.has(object.name) ||
    property?.type !== 'Identifier' ||
    property.name !== 'use'
  ) {
    return false;
  }

  return (expression.arguments ?? []).some(middlewareReturnsResponse);
}

function middlewareReturnsResponse(value: unknown): boolean {
  const middleware = toNodeView(value);
  if (
    middleware?.type !== 'ArrowFunctionExpression' &&
    middleware?.type !== 'FunctionExpression'
  ) {
    return false;
  }

  return containsResponseReturn(middleware.body);
}

function containsResponseReturn(value: unknown): boolean {
  const node = toNodeView(value);
  if (!node) {
    return false;
  }

  if (node.type === 'CallExpression') {
    return isContextResponseCall(node);
  }
  if (node.type === 'ReturnStatement') {
    return containsResponseReturn(node.argument);
  }
  if (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'FunctionDeclaration'
  ) {
    return false;
  }

  return Object.entries(node).some(
    ([key, child]) =>
      key !== 'span' &&
      (Array.isArray(child)
        ? child.some(containsResponseReturn)
        : containsResponseReturn(child))
  );
}

const CONTEXT_RESPONSE_METHODS = new Set([
  'body',
  'html',
  'json',
  'notFound',
  'redirect',
  'text',
]);

function isContextResponseCall(value: NodeView): boolean {
  const callee = toNodeView(value.callee);
  const property = toNodeView(callee?.property);

  return (
    callee?.type === 'MemberExpression' &&
    property?.type === 'Identifier' &&
    property.name !== undefined &&
    CONTEXT_RESPONSE_METHODS.has(property.name)
  );
}
