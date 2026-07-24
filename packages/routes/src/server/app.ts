import { readFile } from 'node:fs/promises';

import type { NodeView } from './ast.ts';
import {
  asNode,
  importedAs,
  isHonoExpression,
  isTransparentExpression,
  parseModule,
  specifierNames,
} from './ast.ts';

export type AppModuleAnalysis = {
  hasEarlyResponseMiddleware: boolean;
};

export async function validateAppModule(
  file: string
): Promise<AppModuleAnalysis> {
  const source = await readFile(file, 'utf8');
  const ast = parseModule(file, source, 'app module');
  const factories = importedAs(ast, 'defineApp');
  // `defineApp()` only calls `new Hono()`, so an app module that reaches for
  // Hono directly is just as valid an application root.
  const constructors = importedAs(ast, 'Hono');
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
      `[daroyan] Invalid app module ${file}: default-export a Hono instance, created either by defineApp() or by new Hono().`
    );
  }

  return {
    hasEarlyResponseMiddleware: ast.body.some((statement) =>
      isEarlyResponseUseStatement(statement, apps)
    ),
  };
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
  const node = asNode(value);
  if (!node) {
    return false;
  }

  if (node.type === 'CallExpression') {
    const callee = asNode(node.callee);
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
  const statement = asNode(value);
  if (statement?.type !== 'ExpressionStatement') {
    return false;
  }

  const expression = asNode(statement.expression);
  if (expression?.type !== 'CallExpression') {
    return false;
  }

  const callee = asNode(expression.callee);
  const object = asNode(callee?.object);
  const property = asNode(callee?.property);
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
  const middleware = asNode(value);
  if (
    middleware?.type !== 'ArrowFunctionExpression' &&
    middleware?.type !== 'FunctionExpression'
  ) {
    return false;
  }

  return containsResponseReturn(middleware.body);
}

function containsResponseReturn(value: unknown): boolean {
  const node = asNode(value);
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
  const callee = asNode(value.callee);
  const property = asNode(callee?.property);

  return (
    callee?.type === 'MemberExpression' &&
    property?.type === 'Identifier' &&
    property.name !== undefined &&
    CONTEXT_RESPONSE_METHODS.has(property.name)
  );
}
