import { readFile } from 'node:fs/promises';

import type { Method } from '../../constants.ts';
import { HTTP_METHODS } from '../../constants.ts';
import {
  isHonoInstance,
  parseModule,
  toSpecifierNames,
  toMethodCall,
} from '../ast.ts';
import { couldBeHandlerTuple, handlerCount } from './tuples.ts';
import {
  isValidatorImport,
  objectSchemaKeys,
  parameterSchemasIn,
} from './validators.ts';

export type RouteExports = {
  /** Handler tuple length per method, or `null` when a spread makes it unknown. */
  handlerCounts: Partial<Record<Method, number | null>>;
  hasDefault: boolean;
  /** Whether the default export mutates its router outside the chain. */
  hasUnchainedRoutes: boolean;
  /** Method exports that are not a readable `defineHandler()` tuple. */
  invalidMethods: Method[];
  isDefaultHono: boolean;
  methods: Method[];
  /** The parameter keys each validator in the module declares. */
  parameterSchemas: string[][];
};

export async function readRouteExports(file: string): Promise<RouteExports> {
  const ast = parseModule(file, await readFile(file, 'utf8'), 'route module');
  const exports = new Set<string>();
  const handlerTuples = new Map<string, number | null>();
  const handlerFactories = new Set<string>();
  const tupleNames = new Map<Method, string>();
  const schemasByTuple = new Map<string, string[][]>();
  const namedSchemas = new Map<string, string[]>();
  const validators = new Set<string>();
  const honoConstructors = new Set<string>();
  const honoInstances = new Set<string>();
  const invalidMethods = new Set<Method>();
  let hasDefault = false;
  let isDefaultHono = false;
  let defaultHonoName: string | undefined;

  for (const statement of ast.body) {
    if (statement.type !== 'ImportDeclaration') {
      continue;
    }

    const moduleSource =
      typeof statement.source.value === 'string' ? statement.source.value : '';

    for (const specifier of statement.specifiers) {
      if (
        specifier.type !== 'ImportSpecifier' ||
        specifier.imported.type !== 'Identifier'
      ) {
        continue;
      }

      if (specifier.imported.name === 'Hono') {
        honoConstructors.add(specifier.local.name);
      }
      if (specifier.imported.name === 'defineHandler') {
        handlerFactories.add(specifier.local.name);
      }
      if (isValidatorImport(moduleSource, specifier.imported.name)) {
        validators.add(specifier.local.name);
      }
    }
  }

  for (const statement of ast.body) {
    const statementDeclaration =
      statement.type === 'ExportNamedDeclaration'
        ? statement.declaration
        : statement;
    if (statementDeclaration?.type !== 'VariableDeclaration') {
      continue;
    }

    for (const declaration of statementDeclaration.declarations) {
      if (declaration.id.type !== 'Identifier') {
        continue;
      }

      const schemaKeys = objectSchemaKeys(declaration.init, namedSchemas);
      if (schemaKeys) {
        namedSchemas.set(declaration.id.name, schemaKeys);
      }
      if (isHonoInstance(declaration.init, honoConstructors, honoInstances)) {
        honoInstances.add(declaration.id.name);
      }
      if (couldBeHandlerTuple(declaration.init, handlerFactories)) {
        handlerTuples.set(
          declaration.id.name,
          handlerCount(declaration.init, handlerFactories, handlerTuples) ??
            null
        );
        schemasByTuple.set(
          declaration.id.name,
          parameterSchemasIn(declaration.init, validators, namedSchemas)
        );
      }
    }
  }

  for (const statement of ast.body) {
    if (statement.type === 'ExportDefaultDeclaration') {
      hasDefault = true;
      isDefaultHono = isHonoInstance(
        statement.declaration,
        honoConstructors,
        honoInstances
      );
      if (statement.declaration.type === 'Identifier') {
        defaultHonoName = statement.declaration.name;
      }
      continue;
    }

    if (statement.type !== 'ExportNamedDeclaration') {
      continue;
    }

    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ExportSpecifier') {
        continue;
      }

      const { exported: name, local: localName } = toSpecifierNames(specifier);
      if (name === 'default') {
        hasDefault = true;
        if (statement.source === null && honoInstances.has(localName)) {
          isDefaultHono = true;
          defaultHonoName = localName;
        }
        continue;
      }

      exports.add(name);
      if (!HTTP_METHODS.includes(name as Method)) {
        continue;
      }

      const method = name as Method;
      if (statement.source !== null) {
        invalidMethods.add(method);
        continue;
      }

      tupleNames.set(method, localName);
      if (!handlerTuples.has(localName)) {
        invalidMethods.add(method);
      }
    }

    if (
      statement.declaration?.type === 'FunctionDeclaration' ||
      statement.declaration?.type === 'ClassDeclaration' ||
      statement.declaration?.type === 'TSEnumDeclaration'
    ) {
      const name = statement.declaration.id?.name;
      if (name && HTTP_METHODS.includes(name as Method)) {
        exports.add(name);
        invalidMethods.add(name as Method);
      }
    }

    if (statement.declaration?.type === 'VariableDeclaration') {
      for (const declaration of statement.declaration.declarations) {
        if (declaration.id.type !== 'Identifier') {
          continue;
        }

        const name = declaration.id.name;
        exports.add(name);
        if (!HTTP_METHODS.includes(name as Method)) {
          continue;
        }
        if (!handlerTuples.has(name)) {
          invalidMethods.add(name as Method);
        }
        tupleNames.set(name as Method, name);
      }
    }
  }

  const methods = HTTP_METHODS.filter((method) => exports.has(method));

  return {
    handlerCounts: Object.fromEntries(
      methods.map((method) => [
        method,
        handlerTuples.get(tupleNames.get(method) ?? method) ?? null,
      ])
    ),
    hasDefault,
    hasUnchainedRoutes:
      defaultHonoName !== undefined &&
      ast.body.some((statement) => {
        const call = toMethodCall(statement);
        return (
          call?.object === defaultHonoName &&
          HONO_ROUTE_METHODS.has(call.method)
        );
      }),
    invalidMethods: HTTP_METHODS.filter((method) => invalidMethods.has(method)),
    isDefaultHono,
    methods,
    parameterSchemas: methods.flatMap(
      (method) => schemasByTuple.get(tupleNames.get(method) ?? method) ?? []
    ),
  };
}

/** Rejects the export shapes the emitter cannot register. */
export function assertRouteExports(
  file: string,
  routeExports: RouteExports
): void {
  if (routeExports.invalidMethods.length > 0) {
    throw new Error(
      `[shinro] Invalid route ${file}: ${routeExports.invalidMethods.join(
        ', '
      )} must use defineHandler() to export a handler tuple.`
    );
  }

  if (routeExports.hasDefault && routeExports.methods.length > 0) {
    throw new Error(
      `[shinro] Invalid route ${file}: cannot mix a default sub-router export with named method exports (${routeExports.methods.join(
        ', '
      )}).`
    );
  }

  if (routeExports.hasDefault && !routeExports.isDefaultHono) {
    throw new Error(
      `[shinro] Invalid route ${file}: the default export must be a chained Hono sub-router.`
    );
  }

  if (routeExports.hasUnchainedRoutes) {
    throw new Error(
      `[shinro] Invalid route ${file}: default sub-router routes must be chained and assigned so Hono retains their RPC schema.`
    );
  }
}

export async function readMiddlewareCount(
  file: string
): Promise<number | null> {
  const ast = parseModule(file, await readFile(file, 'utf8'), 'route module');
  const middlewareTuples = new Map<string, number | null>();
  const middlewareFactories = new Set<string>();
  let count: number | null | undefined;

  for (const statement of ast.body) {
    if (statement.type !== 'ImportDeclaration') {
      continue;
    }

    for (const specifier of statement.specifiers) {
      if (
        specifier.type === 'ImportSpecifier' &&
        specifier.imported.type === 'Identifier' &&
        specifier.imported.name === 'defineMiddleware'
      ) {
        middlewareFactories.add(specifier.local.name);
      }
    }
  }

  for (const statement of ast.body) {
    const statementDeclaration =
      statement.type === 'ExportNamedDeclaration'
        ? statement.declaration
        : statement;
    if (statementDeclaration?.type !== 'VariableDeclaration') {
      continue;
    }

    for (const declaration of statementDeclaration.declarations) {
      const tupleCount = handlerCount(
        declaration.init,
        middlewareFactories,
        middlewareTuples
      );
      if (declaration.id.type === 'Identifier' && tupleCount !== undefined) {
        middlewareTuples.set(declaration.id.name, tupleCount);
      }
    }
  }

  for (const statement of ast.body) {
    if (statement.type === 'ExportDefaultDeclaration') {
      count = handlerCount(
        statement.declaration,
        middlewareFactories,
        middlewareTuples
      );
      break;
    }

    if (
      statement.type !== 'ExportNamedDeclaration' ||
      statement.source !== null
    ) {
      continue;
    }

    for (const specifier of statement.specifiers) {
      const names = toSpecifierNames(specifier);
      if (names.exported === 'default' && middlewareTuples.has(names.local)) {
        count = middlewareTuples.get(names.local);
      }
    }
  }

  if (count === undefined) {
    throw new Error(
      `[shinro] Invalid directory middleware ${file}: the default export must use defineMiddleware() to return a non-empty middleware tuple with at least one middleware.`
    );
  }

  return count;
}

/** Hono methods that register something, so calling one off-chain loses its types. */
const HONO_ROUTE_METHODS = new Set([
  'all',
  'delete',
  'get',
  'head',
  'on',
  'options',
  'patch',
  'post',
  'put',
  'route',
  'use',
]);
