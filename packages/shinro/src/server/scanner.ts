import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';

import { minimatch } from 'minimatch';

import { HTTP_METHODS } from '../constants.ts';
import type { NodeView } from './ast.ts';
import {
  asNode,
  isHonoExpression,
  isTransparentExpression,
  parseModule,
  specifierNames,
} from './ast.ts';
import {
  isStrictlyWithin,
  routeParameterNames,
  toProjectPath,
} from './path.ts';

export type Route = {
  file: string;
  kind: 'methods' | 'sub-router';
  methods: (typeof HTTP_METHODS)[number][];
  middleware: string[];
  path: string;
};

type DirectoryMiddleware = {
  file: string;
  path: string;
};

type SegmentPart = {
  escaped: boolean;
  text: string;
};

type PathSegment = {
  escaped: boolean;
  literal: string;
};

type RouteManifest = {
  middleware: DirectoryMiddleware[];
  routes: Route[];
};

export async function discoverRoutes(
  routesDirectory: string,
  options: {
    ignoredRouteFiles?: string[];
    warn?: (message: string) => void;
  } = {}
): Promise<RouteManifest> {
  let entries;
  try {
    entries = await readdir(routesDirectory, {
      recursive: true,
      withFileTypes: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `[shinro] Routes directory not found: ${routesDirectory}\nCreate it or configure shinro({ routes: "path/to/routes" }).`,
        { cause: error }
      );
    }
    throw error;
  }
  const routes: Route[] = [];
  const middleware = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name === '_middleware.ts' || entry.name === '_middleware.js')
    )
    .map((entry) => resolve(entry.parentPath, entry.name))
    .filter(
      (file) =>
        !isInIgnoredDirectory(routesDirectory, file) &&
        !matchesIgnoredRouteFile(
          routesDirectory,
          file,
          options.ignoredRouteFiles
        )
    );

  await settleInOrder(middleware.map(validateMiddlewareModule));

  const candidates = entries
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name))
    .filter(
      (file) =>
        !isIgnoredRouteFile(routesDirectory, file) &&
        !matchesIgnoredRouteFile(
          routesDirectory,
          file,
          options.ignoredRouteFiles
        )
    );
  // Route modules are read and parsed concurrently, then inspected in directory
  // order so diagnostics stay deterministic regardless of which parse lands
  // first.
  const parsed = await settleInOrder(candidates.map(readRouteExports));

  for (const [index, file] of candidates.entries()) {
    const routeExports = parsed[index];
    const path = routePath(routesDirectory, file);

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

    if (routeExports.hasDefault && !routeExports.defaultIsHono) {
      throw new Error(
        `[shinro] Invalid route ${file}: the default export must be a chained Hono sub-router.`
      );
    }

    if (routeExports.defaultHasUnchainedRoutes) {
      throw new Error(
        `[shinro] Invalid route ${file}: default sub-router routes must be chained and assigned so Hono retains their RPC schema.`
      );
    }

    if (routeExports.methods.length === 0 && !routeExports.hasDefault) {
      options.warn?.(
        `[shinro] Ignoring ${file}: the route file has no supported method export. Export one of ${HTTP_METHODS.join(
          ', '
        )}.`
      );
      continue;
    }

    const filenameParameters = routeParameterNames(path);
    for (const schemaParameters of routeExports.parameterSchemas) {
      if (!sameStringSet(filenameParameters, schemaParameters)) {
        options.warn?.(
          `[shinro] ${file} has a parameter schema declaring [${schemaParameters.join(
            ', '
          )}], but its filename path ${path} declares [${filenameParameters.join(', ')}].`
        );
      }
    }

    routes.push({
      file,
      kind: routeExports.hasDefault ? 'sub-router' : 'methods',
      methods: routeExports.methods,
      // Every applicable middleware directory is an ancestor of this file, so
      // sorting by depth orders the chain from the route root down to the leaf.
      middleware: middleware
        .filter((middlewareFile) =>
          isStrictlyWithin(dirname(middlewareFile), file)
        )
        .sort(
          (left, right) =>
            left.split(sep).length - right.split(sep).length ||
            left.localeCompare(right)
        ),
      path,
    });
  }

  return {
    middleware: middleware.map((file) => ({
      file,
      path: routePath(
        routesDirectory,
        resolve(dirname(file), 'index.ts'),
        file
      ),
    })),
    routes: routes.sort(compareRoutes),
  };
}

// Awaits everything concurrently but surfaces the first failure in argument
// order, so parallel work cannot make error reporting depend on scheduling.
async function settleInOrder<T>(work: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(work);
  const values: T[] = [];

  for (const result of settled) {
    if (result.status === 'rejected') {
      throw result.reason;
    }
    values.push(result.value);
  }

  return values;
}

async function validateMiddlewareModule(file: string): Promise<void> {
  const source = await readFile(file, 'utf8');
  const ast = parseModule(file, source, 'route module');
  const middlewareBundles = new Set<string>();
  const middlewareFactories = new Set<string>();
  let hasValidDefault = false;

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
      if (
        declaration.id.type === 'Identifier' &&
        isHandlerBundleExpression(
          declaration.init,
          middlewareFactories,
          middlewareBundles
        )
      ) {
        middlewareBundles.add(declaration.id.name);
      }
    }
  }

  for (const statement of ast.body) {
    if (statement.type === 'ExportDefaultDeclaration') {
      hasValidDefault = isHandlerBundleExpression(
        statement.declaration,
        middlewareFactories,
        middlewareBundles
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
      const names = specifierNames(specifier);
      if (names.exported === 'default' && middlewareBundles.has(names.local)) {
        hasValidDefault = true;
      }
    }
  }

  if (!hasValidDefault) {
    throw new Error(
      `[shinro] Invalid directory middleware ${file}: the default export must use defineMiddleware() to return a non-empty middleware tuple with at least one middleware.`
    );
  }
}

export function validateRoutes(
  routes: Route[],
  root: string,
  routesDirectory: string
): void {
  // Each route's shape is derived once. Computing it inside the pairwise scan
  // ran two regex replacements per comparison, which grows quadratically with
  // the route count.
  const shapes = routes.map((route) => routeShape(route.path));
  const hasSubRouter = routes.some((route) => route.kind === 'sub-router');

  for (let leftIndex = 0; leftIndex < routes.length; leftIndex += 1) {
    const left = routes[leftIndex];

    for (
      let rightIndex = leftIndex + 1;
      rightIndex < routes.length;
      rightIndex += 1
    ) {
      const right = routes[rightIndex];
      const sameShape = shapes[leftIndex] === shapes[rightIndex];
      const subRouterOverlap =
        hasSubRouter &&
        (reservesPath(left, right.path) || reservesPath(right, left.path));

      if (!sameShape && !subRouterOverlap) {
        continue;
      }

      // Two files at different depths collapsing onto one URL reads as a
      // contradiction unless the message says why, so a group in either path
      // explains itself here.
      const groupHint =
        isInGroupDirectory(routesDirectory, left.file) ||
        isInGroupDirectory(routesDirectory, right.file)
          ? [GROUP_SEGMENT_HINT]
          : [];

      if (subRouterOverlap) {
        const owner = reservesPath(left, right.path) ? left : right;
        const descendant = owner === left ? right : left;

        throw new Error(
          [
            `[shinro] Route namespace conflict at ${JSON.stringify(owner.path)}:`,
            `- ${toProjectPath(root, owner.file)}`,
            `- ${toProjectPath(root, descendant.file)}`,
            `The default sub-router at ${owner.path} owns its complete mount namespace.`,
            ...groupHint,
          ].join('\n')
        );
      }

      throw new Error(
        [
          `[shinro] Route conflict at ${JSON.stringify(sameShape ? left.path : `${left.path} ↔ ${right.path}`)}:`,
          `- ${toProjectPath(root, left.file)}`,
          `- ${toProjectPath(root, right.file)}`,
          ...groupHint,
        ].join('\n')
      );
    }
  }
}

/**
 * Whether a file inside the routes directory can change the route tree, so a
 * watcher can skip regenerating for READMEs, fixtures, snapshots, and the other
 * files that live alongside routes.
 */
export function affectsRouteTree(
  routesDirectory: string,
  file: string,
  ignoredRouteFiles: string[] | undefined
): boolean {
  if (matchesIgnoredRouteFile(routesDirectory, file, ignoredRouteFiles)) {
    return false;
  }

  return (
    isDirectoryMiddleware(file) || !isIgnoredRouteFile(routesDirectory, file)
  );
}

function isDirectoryMiddleware(file: string): boolean {
  const name = basename(file);
  return name === '_middleware.ts' || name === '_middleware.js';
}

function matchesIgnoredRouteFile(
  routesDirectory: string,
  file: string,
  patterns: string[] | undefined
): boolean {
  if (!patterns || patterns.length === 0) {
    return false;
  }

  const routeRelativeFile = relative(routesDirectory, file)
    .split(sep)
    .join('/');
  return patterns.some((pattern) => minimatch(routeRelativeFile, pattern));
}

function isIgnoredRouteFile(routesDirectory: string, file: string): boolean {
  const basename = file.split(sep).at(-1) ?? '';
  const supportedExtension =
    basename.endsWith('.ts') || basename.endsWith('.js');

  return (
    !supportedExtension ||
    basename.startsWith('_') ||
    basename.startsWith('.') ||
    basename.endsWith('.d.ts') ||
    /\.(?:test|spec)\./.test(basename) ||
    isInIgnoredDirectory(routesDirectory, file)
  );
}

function isInIgnoredDirectory(routesDirectory: string, file: string): boolean {
  const segments = relative(routesDirectory, dirname(file)).split(sep);
  return segments.some(
    (segment) =>
      segment.startsWith('.') ||
      segment === '__tests__' ||
      segment === '__fixtures__' ||
      segment === '+types'
  );
}

async function readRouteExports(file: string): Promise<{
  defaultIsHono: boolean;
  defaultHasUnchainedRoutes: boolean;
  hasDefault: boolean;
  invalidMethods: Route['methods'];
  methods: Route['methods'];
  parameterSchemas: string[][];
}> {
  const source = await readFile(file, 'utf8');
  const ast = parseModule(file, source, 'route module');
  const exports = new Set<string>();
  const handlerBundles = new Set<string>();
  const handlerFactories = new Set<string>();
  const methodBundleNames = new Map<Route['methods'][number], string>();
  const parameterSchemasByBundle = new Map<string, string[][]>();
  const parameterSchemaShapes = new Map<string, string[]>();
  const validatorFactories = new Set<string>();
  const honoConstructors = new Set<string>();
  const honoValues = new Set<string>();
  const invalidMethods = new Set<Route['methods'][number]>();
  let hasDefault = false;
  let defaultIsHono = false;
  let defaultHonoName: string | undefined;

  for (const statement of ast.body) {
    if (statement.type !== 'ImportDeclaration') {
      continue;
    }

    const source =
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
      if (isValidatorImport(source, specifier.imported.name)) {
        validatorFactories.add(specifier.local.name);
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
      if (declaration.id.type === 'Identifier') {
        const schemaKeys = objectSchemaKeys(
          declaration.init,
          parameterSchemaShapes
        );
        if (schemaKeys) {
          parameterSchemaShapes.set(declaration.id.name, schemaKeys);
        }
      }
      if (
        declaration.id.type === 'Identifier' &&
        isHonoExpression(declaration.init, honoConstructors, honoValues)
      ) {
        honoValues.add(declaration.id.name);
      }
      if (
        declaration.id.type === 'Identifier' &&
        !isRejectedHandlerBundle(declaration.init, handlerFactories)
      ) {
        handlerBundles.add(declaration.id.name);
        parameterSchemasByBundle.set(
          declaration.id.name,
          parameterSchemasInExpression(
            declaration.init,
            validatorFactories,
            parameterSchemaShapes
          )
        );
      }
    }
  }

  for (const statement of ast.body) {
    if (statement.type === 'ExportDefaultDeclaration') {
      hasDefault = true;
      defaultIsHono = isHonoExpression(
        statement.declaration,
        honoConstructors,
        honoValues
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

      const { exported: name, local: localName } = specifierNames(specifier);
      if (name === 'default') {
        hasDefault = true;
        if (statement.source === null && honoValues.has(localName)) {
          defaultIsHono = true;
          defaultHonoName = localName;
        }
        continue;
      }

      exports.add(name);
      if (!HTTP_METHODS.includes(name as Route['methods'][number])) {
        continue;
      }

      const method = name as Route['methods'][number];
      // A re-export cannot be inspected here, so it is rejected rather than
      // allowed to fail later as a spread of something unknown.
      if (statement.source !== null) {
        invalidMethods.add(method);
        continue;
      }

      methodBundleNames.set(method, localName);
      if (!handlerBundles.has(localName)) {
        invalidMethods.add(method);
      }
    }

    if (
      statement.declaration?.type === 'FunctionDeclaration' ||
      statement.declaration?.type === 'ClassDeclaration' ||
      statement.declaration?.type === 'TSEnumDeclaration'
    ) {
      const name = statement.declaration.id?.name;
      if (name && HTTP_METHODS.includes(name as Route['methods'][number])) {
        exports.add(name);
        invalidMethods.add(name as Route['methods'][number]);
      }
    }

    if (statement.declaration?.type === 'VariableDeclaration') {
      for (const declaration of statement.declaration.declarations) {
        if (declaration.id.type === 'Identifier') {
          exports.add(declaration.id.name);
          if (
            HTTP_METHODS.includes(
              declaration.id.name as Route['methods'][number]
            ) &&
            !handlerBundles.has(declaration.id.name)
          ) {
            invalidMethods.add(declaration.id.name as Route['methods'][number]);
          }
          if (
            HTTP_METHODS.includes(
              declaration.id.name as Route['methods'][number]
            )
          ) {
            methodBundleNames.set(
              declaration.id.name as Route['methods'][number],
              declaration.id.name
            );
          }
        }
      }
    }
  }

  return {
    defaultIsHono,
    defaultHasUnchainedRoutes:
      defaultHonoName !== undefined &&
      ast.body.some((statement) =>
        isUnchainedRouteMutation(statement, defaultHonoName)
      ),
    hasDefault,
    invalidMethods: HTTP_METHODS.filter((method) => invalidMethods.has(method)),
    methods: HTTP_METHODS.filter((method) => exports.has(method)),
    parameterSchemas: HTTP_METHODS.flatMap((method) =>
      exports.has(method)
        ? (parameterSchemasByBundle.get(
            methodBundleNames.get(method) ?? method
          ) ?? [])
        : []
    ),
  };
}

// Hono's validators all share the `factory("param", schema)` shape, so the
// filename/schema cross-check applies to the whole ecosystem rather than to
// `@hono/zod-validator` alone. Recognise them by module — `hono/validator` and
// the `@hono/*-validator` packages — and fall back to the naming convention so
// validators re-exported through a project barrel still count.
function isValidatorImport(source: string, importedName: string): boolean {
  if (source === 'hono/validator' || /^@hono\/.+-validator$/.test(source)) {
    return true;
  }

  return importedName === 'validator' || importedName.endsWith('Validator');
}

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

function isUnchainedRouteMutation(value: unknown, honoName: string): boolean {
  const statement = asNode(value);
  if (statement?.type !== 'ExpressionStatement') {
    return false;
  }

  const expression = asNode(statement.expression);
  const callee = asNode(expression?.callee);
  const object = asNode(callee?.object);
  const property = asNode(callee?.property);

  return (
    expression?.type === 'CallExpression' &&
    callee?.type === 'MemberExpression' &&
    object?.type === 'Identifier' &&
    object.name === honoName &&
    property?.type === 'Identifier' &&
    property.name !== undefined &&
    HONO_ROUTE_METHODS.has(property.name)
  );
}

function isHandlerBundleExpression(
  value: unknown,
  factories: Set<string>,
  bundles: Set<string>
): boolean {
  const node = asNode(value);
  if (!node) {
    return false;
  }

  if (node.type === 'Identifier') {
    return node.name !== undefined && bundles.has(node.name);
  }
  if (node.type === 'ArrayExpression') {
    const elements =
      (node as NodeView & { elements?: unknown[] }).elements ?? [];
    return elements.length > 0 && elements.every(isHandlerValue);
  }
  if (node.type === 'CallExpression') {
    const callee = asNode(node.callee);
    const arguments_ =
      (node as NodeView & { arguments?: unknown[] }).arguments ?? [];
    return (
      callee?.type === 'Identifier' &&
      callee.name !== undefined &&
      factories.has(callee.name) &&
      arguments_.length > 0 &&
      arguments_.every(isHandlerValue)
    );
  }
  if (isTransparentExpression(node)) {
    return isHandlerBundleExpression(node.expression, factories, bundles);
  }

  return false;
}

// A method export is spread into Hono (`...GET`), so a value that provably is
// not a handler tuple is worth rejecting early with a precise message. Anything
// else — a project wrapper, a shared tuple, a helper call — is left to
// TypeScript, which checks spreadability exactly and reports it against the
// user's own source rather than against generated code.
function isRejectedHandlerBundle(
  value: unknown,
  factories: Set<string>
): boolean {
  const node = asNode(value);
  if (!node) {
    return true;
  }

  if (isTransparentExpression(node)) {
    return isRejectedHandlerBundle(node.expression, factories);
  }

  if (node.type === 'ArrayExpression') {
    const elements =
      (node as NodeView & { elements?: unknown[] }).elements ?? [];
    return elements.length === 0 || !elements.every(isHandlerValue);
  }
  if (node.type === 'CallExpression') {
    const callee = asNode(node.callee);
    const arguments_ =
      (node as NodeView & { arguments?: unknown[] }).arguments ?? [];
    return (
      callee?.type === 'Identifier' &&
      callee.name !== undefined &&
      factories.has(callee.name) &&
      (arguments_.length === 0 || !arguments_.every(isHandlerValue))
    );
  }

  return (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'ClassExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'Literal' ||
    node.type === 'NewExpression' ||
    node.type === 'ObjectExpression' ||
    node.type === 'TemplateLiteral'
  );
}

function isHandlerValue(value: unknown): boolean {
  const node = asNode(value);
  if (!node) {
    return false;
  }

  if (
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'CallExpression' ||
    node.type === 'FunctionExpression' ||
    node.type === 'Identifier' ||
    node.type === 'MemberExpression'
  ) {
    return true;
  }
  if (node.type === 'SpreadElement') {
    return isHandlerValue((node as NodeView & { argument?: unknown }).argument);
  }
  if (isTransparentExpression(node)) {
    return isHandlerValue(node.expression);
  }

  return false;
}

function parameterSchemasInExpression(
  value: unknown,
  validatorFactories: Set<string>,
  namedSchemas: Map<string, string[]>
): string[][] {
  const schemas: string[][] = [];

  visitNode(value, (node) => {
    if (node.type !== 'CallExpression') {
      return;
    }

    const callee = asNode(node.callee);
    const arguments_ =
      (node as NodeView & { arguments?: unknown[] }).arguments ?? [];
    const target = asNode(arguments_[0]) as
      | (NodeView & { value?: unknown })
      | undefined;
    if (
      callee?.type !== 'Identifier' ||
      callee.name === undefined ||
      !validatorFactories.has(callee.name) ||
      target?.type !== 'Literal' ||
      target.value !== 'param'
    ) {
      return;
    }

    const keys = objectSchemaKeys(arguments_[1], namedSchemas);
    if (keys) {
      schemas.push(keys);
    }
  });

  return schemas;
}

function objectSchemaKeys(
  value: unknown,
  namedSchemas: Map<string, string[]>
): string[] | undefined {
  const schema = asNode(value);
  if (schema?.type === 'Identifier' && schema.name !== undefined) {
    return namedSchemas.get(schema.name);
  }
  if (schema?.type !== 'CallExpression') {
    return undefined;
  }

  const callee = asNode(schema.callee);
  const property = asNode(callee?.property);
  const arguments_ =
    (schema as NodeView & { arguments?: unknown[] }).arguments ?? [];
  const shape = asNode(arguments_[0]) as
    | (NodeView & { properties?: unknown[] })
    | undefined;
  if (
    callee?.type !== 'MemberExpression' ||
    property?.type !== 'Identifier' ||
    property.name !== 'object' ||
    shape?.type !== 'ObjectExpression'
  ) {
    return undefined;
  }

  const keys: string[] = [];
  for (const value of shape.properties ?? []) {
    const field = asNode(value) as
      | (NodeView & { computed?: boolean; key?: unknown })
      | undefined;
    const key = asNode(field?.key) as
      | (NodeView & { value?: unknown })
      | undefined;
    if (field?.type !== 'Property' || field.computed || !key) {
      return undefined;
    }
    if (key.type === 'Identifier' && key.name !== undefined) {
      keys.push(key.name);
    } else if (key.type === 'Literal' && typeof key.value === 'string') {
      keys.push(key.value);
    } else {
      return undefined;
    }
  }

  return keys;
}

function visitNode(value: unknown, visitor: (node: NodeView) => void): void {
  const node = asNode(value);
  if (!node) {
    return;
  }

  visitor(node);
  for (const [key, child] of Object.entries(node)) {
    if (key === 'span' || key === 'start' || key === 'end') {
      continue;
    }
    if (Array.isArray(child)) {
      for (const item of child) {
        visitNode(item, visitor);
      }
    } else {
      visitNode(child, visitor);
    }
  }
}

function sameStringSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value)) &&
    right.every((value) => left.includes(value))
  );
}

/**
 * The URL a route file serves.
 *
 * `reportedFile` exists because directory middleware derives its own URL from a
 * synthetic `index.ts` inside its directory, so every diagnostic here must name
 * the file the user actually wrote rather than one that does not exist.
 */
function routePath(
  routesDirectory: string,
  file: string,
  reportedFile: string = file
): string {
  const relativeFile = relative(routesDirectory, file).split(sep).join('/');
  const pathSegments = relativeFile.replace(/\.[^.]+$/, '').split('/');
  const lastIndex = pathSegments.length - 1;
  const segments: PathSegment[] = [];

  for (const [index, segment] of pathSegments.entries()) {
    const parts = segmentParts(segment);

    if (parts.some((part) => part.escaped) || !isGroupSegment(segment)) {
      segments.push(pathSegment(reportedFile, parts, segment));
      continue;
    }

    // Grouping is a property of a directory. A file has no descendants to group,
    // and dropping its segment would alias the route onto its parent's URL, so
    // the two readings get two spellings instead of one and a guess.
    if (index === lastIndex) {
      throw new Error(
        `[shinro] Invalid route ${reportedFile}: ${JSON.stringify(
          segment
        )} names a route group, which only a directory can be. Move the route into a ${JSON.stringify(
          segment
        )} directory, or rename it to ${JSON.stringify(
          `[${segment}]`
        )} to serve ${JSON.stringify(`/${segment}`)} literally.`
      );
    }

    assertGroupName(reportedFile, segment);
    // A group directory contributes middleware ancestry but no URL segment, so
    // it is dropped before anything below reads the derived path. That ordering
    // is what makes the catch-all and duplicate-parameter rules describe the URL
    // a route serves rather than how deeply it nests on disk.
  }

  const lastSegment = segments.at(-1);
  if (lastSegment && !lastSegment.escaped && lastSegment.literal === 'index') {
    segments.pop();
  }

  const catchAllIndex = segments.findIndex(
    (segment) => !segment.escaped && segment.literal.startsWith('$...')
  );
  if (catchAllIndex !== -1 && catchAllIndex !== segments.length - 1) {
    throw new Error(
      `[shinro] Invalid route ${reportedFile}: catch-all segment ${JSON.stringify(
        segments[catchAllIndex].literal
      )} must be final.`
    );
  }

  const parameters = new Set<string>();
  for (const segment of segments) {
    if (segment.escaped || !segment.literal.startsWith('$')) {
      continue;
    }

    const parameter = segment.literal.startsWith('$...')
      ? segment.literal.slice(4)
      : segment.literal.slice(1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter)) {
      throw new Error(
        `[shinro] Invalid route ${reportedFile}: invalid dynamic parameter name ${JSON.stringify(
          parameter
        )}. Use letters, numbers, and underscores, starting with a letter or underscore.`
      );
    }
    if (parameters.has(parameter)) {
      throw new Error(
        `[shinro] Invalid route ${reportedFile}: duplicate dynamic parameter ${JSON.stringify(
          parameter
        )}. Every filename parameter in a route must have a unique name.`
      );
    }
    parameters.add(parameter);
  }

  const path = segments
    .map((segment) =>
      segment.escaped ? segment.literal : routeSegment(segment.literal)
    )
    .join('/');
  return path ? `/${path}` : '/';
}

/**
 * Splits a filename segment into escaped and unescaped runs. A `[...]` span is
 * emitted literally, which is what lets a URL contain a character that is
 * otherwise route syntax.
 *
 * Matching `[` to the *next* `]` is deliberate: it makes `[[weird]]` resolve to
 * `[weird]` on its own, and leaves an unmatched `[` as an ordinary character, so
 * escaping never needs a diagnostic of its own.
 */
function segmentParts(segment: string): SegmentPart[] {
  const parts: SegmentPart[] = [];
  let index = 0;

  while (index < segment.length) {
    const open = segment.indexOf('[', index);
    const close = open === -1 ? -1 : segment.indexOf(']', open + 1);

    if (close === -1) {
      parts.push({ escaped: false, text: segment.slice(index) });
      break;
    }

    if (open > index) {
      parts.push({ escaped: false, text: segment.slice(index, open) });
    }
    parts.push({ escaped: true, text: segment.slice(open + 1, close) });
    index = close + 1;
  }

  return parts;
}

/**
 * Resolves one segment's escapes and rejects the shapes that cannot be served.
 * An escape makes a segment static: its text reaches the URL verbatim rather
 * than being read as a parameter or a group.
 */
function pathSegment(
  file: string,
  parts: SegmentPart[],
  segment: string
): PathSegment {
  const escaped = parts.some((part) => part.escaped);
  const unescaped = parts
    .filter((part) => !part.escaped)
    .map((part) => part.text)
    .join('');

  // Reached only for a segment that is not a well-formed group, so any bare
  // parenthesis left here is a malformed one.
  if (/[()]/.test(unescaped)) {
    throw new Error(
      `[shinro] Invalid route ${file}: ${JSON.stringify(
        segment
      )} is not a valid route group. Write "(name)" to group routes without adding a URL segment, or ${JSON.stringify(
        `[${segment}]`
      )} to serve the parentheses literally.`
    );
  }

  if (escaped && unescaped.startsWith('$')) {
    throw new Error(
      `[shinro] Invalid route ${file}: dynamic segment ${JSON.stringify(
        segment
      )} cannot contain an escape, because Hono would read the escaped text as part of the parameter name. Escape the whole segment, or drop the escape.`
    );
  }

  const literal = parts.map((part) => part.text).join('');
  const dynamic = !escaped && literal.startsWith('$');
  // A static segment reaches Hono verbatim, so a character Hono treats as path
  // syntax would silently register something else — most sharply `[:]id`, which
  // would become a parameter rather than the literal `:id` it asks for.
  const honoSyntax = dynamic ? null : /[:{}*?]/.exec(literal);
  if (honoSyntax) {
    throw new Error(
      `[shinro] Invalid route ${file}: segment ${JSON.stringify(
        literal
      )} contains ${JSON.stringify(
        honoSyntax[0]
      )}, which is Hono path syntax and cannot be served as a literal URL segment.`
    );
  }

  return { escaped, literal };
}

function assertGroupName(file: string, segment: string): void {
  const name = segment.slice(1, -1);

  if (name.trim() === '') {
    throw new Error(
      `[shinro] Invalid route ${file}: route group ${JSON.stringify(
        segment
      )} needs a name. Name it after what its routes share, such as "(authed)".`
    );
  }

  if (name.startsWith('$')) {
    throw new Error(
      `[shinro] Invalid route ${file}: route group ${JSON.stringify(
        segment
      )} cannot declare a dynamic parameter. A group contributes middleware only, so ${JSON.stringify(
        name
      )} would never reach the URL. Use a ${JSON.stringify(
        name
      )} directory for the parameter.`
    );
  }
}

function routeSegment(segment: string): string {
  if (segment.startsWith('$...')) {
    return `:${segment.slice(4)}{.+}`;
  }

  if (segment.startsWith('$')) {
    return `:${segment.slice(1)}`;
  }

  return segment;
}

function reservesPath(route: Route, path: string): boolean {
  if (route.kind !== 'sub-router') {
    return false;
  }

  const ownerSegments = route.path.split('/').filter(Boolean);
  const candidateSegments = path.split('/').filter(Boolean);
  if (ownerSegments.length === 0) {
    return true;
  }

  for (let index = 0; index < ownerSegments.length; index += 1) {
    const owner = ownerSegments[index];
    const candidate = candidateSegments[index];
    if (candidate === undefined) {
      return false;
    }
    if (isCatchAllSegment(owner) || isCatchAllSegment(candidate)) {
      return true;
    }
    if (
      !isDynamicSegment(owner) &&
      !isDynamicSegment(candidate) &&
      owner !== candidate
    ) {
      return false;
    }
  }

  return true;
}

function routeShape(path: string): string {
  return path
    .replace(/:[^/{}]+\{\.\+\}/g, '$catch-all')
    .replace(/:[^/{}]+/g, '$dynamic');
}

const GROUP_SEGMENT_HINT =
  'A "(group)" directory contributes middleware only, so it adds no URL segment.';

function isInGroupDirectory(routesDirectory: string, file: string): boolean {
  return relative(routesDirectory, file)
    .split(sep)
    .slice(0, -1)
    .some(isGroupSegment);
}

/**
 * Whether a directory name is written as a route group, `(name)`. Recognition is
 * deliberately looser than a valid name so that `()` reads as a malformed group
 * and can say so, rather than falling through to a literal URL segment.
 */
function isGroupSegment(segment: string): boolean {
  return (
    segment.length >= 2 && segment.startsWith('(') && segment.endsWith(')')
  );
}

function isCatchAllSegment(segment: string): boolean {
  return segment.startsWith(':') && segment.endsWith('{.+}');
}

function isDynamicSegment(segment: string): boolean {
  return segment.startsWith(':');
}

function compareRoutes(left: Route, right: Route): number {
  const leftSegments = left.path.split('/').filter(Boolean);
  const rightSegments = right.path.split('/').filter(Boolean);

  for (
    let index = 0;
    index < Math.max(leftSegments.length, rightSegments.length);
    index += 1
  ) {
    const priorityDifference =
      segmentPriority(leftSegments[index]) -
      segmentPriority(rightSegments[index]);

    if (priorityDifference !== 0) {
      return priorityDifference;
    }
  }

  return left.path.localeCompare(right.path);
}

function segmentPriority(segment: string | undefined): number {
  if (segment === undefined) {
    return -1;
  }
  if (segment.endsWith('{.+}')) {
    return 2;
  }
  if (segment.startsWith(':')) {
    return 1;
  }
  return 0;
}
