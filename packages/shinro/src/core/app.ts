import { readFile } from 'node:fs/promises';

import { ROUTES_FILE, ROUTES_SPECIFIER } from '../constants.ts';
import {
  toChildNodes,
  hasCallTo,
  isHonoInstance,
  isWrapperExpression,
  toLocalNames,
  parseModule,
  toSpecifierNames,
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
  const routers = toLocalNames(
    ast,
    'routes',
    (source) =>
      source === ROUTES_SPECIFIER ||
      source === 'shinro/routes' ||
      source.endsWith(`/${ROUTES_FILE}`)
  );
  const factories = toLocalNames(ast, 'defineApp');
  const constructors = toLocalNames(ast, 'Hono');
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
        isAppInstance(variable.init, scope)
      ) {
        apps.add(variable.id.name);
      }
    }
  }

  const validDefault = ast.body.some((statement) => {
    if (statement.type === 'ExportDefaultDeclaration') {
      return isAppInstance(statement.declaration, scope);
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

      const names = toSpecifierNames(specifier);
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
    mountsRoutes: ast.body.some((statement) => hasCallTo(statement, routers)),
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
    if (hasCallTo(statement, routers)) {
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
  if (isWrapperExpression(node)) {
    return appChains(node.expression, routers);
  }

  return node.type === 'CallExpression' ? [chainCalls(node, routers)] : [];
}

function chainCalls(value: unknown, routers: Set<string>): ChainCall[] {
  const node = toNodeView(value);
  if (!node) {
    return [];
  }
  if (isWrapperExpression(node)) {
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
        hasCallTo(argument, routers)
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

function isAppInstance(value: unknown, scope: AppScope): boolean {
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
      ? isAppInstance(callee.object, scope)
      : false;
  }
  if (isWrapperExpression(node)) {
    return isAppInstance(node.expression, scope);
  }

  return isHonoInstance(value, scope.constructors, scope.apps);
}

function middlewareReturnsResponse(value: unknown): boolean {
  const middleware = toNodeView(value);
  if (
    middleware?.type !== 'ArrowFunctionExpression' &&
    middleware?.type !== 'FunctionExpression'
  ) {
    return false;
  }

  return hasResponseReturn(middleware.body);
}

function hasResponseReturn(value: unknown): boolean {
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
    return hasResponseReturn(node.argument);
  }
  if (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'FunctionDeclaration'
  ) {
    return false;
  }

  for (const child of toChildNodes(node)) {
    if (hasResponseReturn(child)) {
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
