import { readFile } from 'node:fs/promises';

import { parseSync } from 'vite-plus';

export type AppModuleAnalysis = {
  hasEarlyResponseMiddleware: boolean;
};

export async function validateAppModule(
  file: string
): Promise<AppModuleAnalysis> {
  const source = await readFile(file, 'utf8');
  const result = parseSync(file, source, { lang: 'ts' });
  if (result.errors.length > 0) {
    throw new Error(
      `[daroyan] Failed to parse app module ${file}:\n${result.errors
        .map((error) => error.codeframe ?? error.message)
        .join('\n')}`
    );
  }
  const ast = result.program;
  const factories = new Set<string>();
  const constructors = new Set<string>();
  const apps = new Set<string>();

  for (const statement of ast.body) {
    if (statement.type === 'ImportDeclaration') {
      for (const specifier of statement.specifiers) {
        if (
          specifier.type !== 'ImportSpecifier' ||
          specifier.imported.type !== 'Identifier'
        ) {
          continue;
        }

        if (specifier.imported.name === 'defineApp') {
          factories.add(specifier.local.name);
        }
        // `defineApp()` only calls `new Hono()`, so an app module that reaches
        // for Hono directly is just as valid an application root.
        if (specifier.imported.name === 'Hono') {
          constructors.add(specifier.local.name);
        }
      }
    }
  }

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

      const exportedName =
        specifier.exported.type === 'Identifier'
          ? specifier.exported.name
          : String(specifier.exported.value);
      const localName =
        specifier.local.type === 'Identifier'
          ? specifier.local.name
          : String(specifier.local.value);

      return exportedName === 'default' && apps.has(localName);
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

type NodeView = {
  arguments?: unknown[];
  body?: unknown;
  callee?: unknown;
  expression?: unknown;
  name?: string;
  object?: unknown;
  property?: unknown;
  type: string;
};

type AppScope = {
  apps: Set<string>;
  constructors: Set<string>;
  factories: Set<string>;
};

function isAppExpression(value: unknown, scope: AppScope): boolean {
  const node = asNode(value);
  if (!node) {
    return false;
  }

  if (node.type === 'Identifier') {
    return node.name !== undefined && scope.apps.has(node.name);
  }
  if (node.type === 'NewExpression') {
    const callee = asNode(node.callee);
    return (
      callee?.type === 'Identifier' &&
      callee.name !== undefined &&
      scope.constructors.has(callee.name)
    );
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
  if (
    node.type === 'ChainExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'TSNonNullExpression'
  ) {
    return isAppExpression(node.expression, scope);
  }

  return false;
}

function asNode(value: unknown): NodeView | undefined {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return undefined;
  }

  return value as NodeView;
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
    return containsResponseReturn(
      (node as NodeView & { argument?: unknown }).argument
    );
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

function isContextResponseCall(value: NodeView): boolean {
  const callee = asNode(value.callee);
  const property = asNode(callee?.property);

  return (
    callee?.type === 'MemberExpression' &&
    property?.type === 'Identifier' &&
    property.name !== undefined &&
    new Set(['body', 'html', 'json', 'notFound', 'redirect', 'text']).has(
      property.name
    )
  );
}
