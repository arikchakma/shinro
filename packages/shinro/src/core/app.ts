import { readFile } from 'node:fs/promises';

import { ROUTES_FILE, ROUTES_SPECIFIER } from '../constants.ts';
import {
  childNodes,
  containsCallTo,
  isHonoExpression,
  isTransparentExpression,
  localNamesForImport,
  parseModule,
  specifierNames,
  toMethodCall,
  toNodeView,
} from './ast.ts';

export type AppModuleAnalysis = {
  hasEarlyResponseMiddleware: boolean;
  mountsRoutes: boolean;
  registersMiddlewareAfterMount: boolean;
};

export async function validateAppModule(
  file: string
): Promise<AppModuleAnalysis> {
  const source = await readFile(file, 'utf8');
  const ast = parseModule(file, source, 'app module');
  const routers = localNamesForImport(
    ast,
    'routes',
    (source) =>
      source === ROUTES_SPECIFIER ||
      source === 'shinro/routes' ||
      source.endsWith(`/${ROUTES_FILE}`)
  );
  const factories = localNamesForImport(ast, 'defineApp');
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
      toAppUse(statement, apps)?.arguments.some(middlewareReturnsResponse)
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

    if (mounted && toAppUse(statement, apps) !== undefined) {
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
    return (node.declarations ?? []).flatMap((variable) =>
      appChains(toNodeView(variable)?.init, routers)
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
      mountsRoutes: (node.arguments ?? []).some((argument) =>
        containsCallTo(argument, routers)
      ),
      name: property?.type === 'Identifier' ? (property.name ?? '') : '',
    },
  ];
}

/** An `app.use(...)` statement, or `undefined` when the statement is not one. */
function toAppUse(
  value: unknown,
  apps: Set<string>
): ReturnType<typeof toMethodCall> {
  const call = toMethodCall(value);
  return call?.method === 'use' && apps.has(call.object) ? call : undefined;
}

type AppScope = {
  apps: Set<string>;
  constructors: Set<string>;
  factories: Set<string>;
};

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
    const callee = toNodeView(node.callee);
    const property = toNodeView(callee?.property);

    return (
      callee?.type === 'MemberExpression' &&
      property?.type === 'Identifier' &&
      property.name !== undefined &&
      CONTEXT_RESPONSE_METHODS.has(property.name)
    );
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

  for (const child of childNodes(node)) {
    if (containsResponseReturn(child)) {
      return true;
    }
  }

  return false;
}

const CONTEXT_RESPONSE_METHODS = new Set([
  'body',
  'html',
  'json',
  'notFound',
  'redirect',
  'text',
]);
