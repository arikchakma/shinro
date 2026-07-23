import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import { parseAst } from "vite-plus";
import { HTTP_METHODS } from "../constants.ts";
import { toProjectPath } from "./paths.ts";

export type Route = {
  file: string;
  kind: "methods" | "sub-router";
  methods: (typeof HTTP_METHODS)[number][];
  middleware: string[];
  path: string;
};

type DirectoryMiddleware = {
  file: string;
  path: string;
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
  } = {},
): Promise<RouteManifest> {
  let entries;
  try {
    entries = await readdir(routesDirectory, {
      recursive: true,
      withFileTypes: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `[daroyan] Routes directory not found: ${routesDirectory}\nCreate it or configure daroyan({ routes: "path/to/routes" }).`,
        { cause: error },
      );
    }
    throw error;
  }
  const routes: Route[] = [];
  const middleware = entries
    .filter(
      (entry) =>
        entry.isFile() && (entry.name === "_middleware.ts" || entry.name === "_middleware.js"),
    )
    .map((entry) => resolve(entry.parentPath, entry.name))
    .filter(
      (file) =>
        !isInIgnoredDirectory(routesDirectory, file) &&
        !matchesIgnoredRouteFile(routesDirectory, file, options.ignoredRouteFiles),
    );

  await Promise.all(middleware.map(validateMiddlewareModule));

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const file = resolve(entry.parentPath, entry.name);

    if (
      isIgnoredRouteFile(routesDirectory, file) ||
      matchesIgnoredRouteFile(routesDirectory, file, options.ignoredRouteFiles)
    ) {
      continue;
    }

    const routeExports = await readRouteExports(file);
    const path = routePath(routesDirectory, file);

    if (routeExports.invalidMethods.length > 0) {
      throw new Error(
        `[daroyan] Invalid route ${file}: ${routeExports.invalidMethods.join(
          ", ",
        )} must use defineHandler() to export a handler tuple.`,
      );
    }

    if (routeExports.hasDefault && routeExports.methods.length > 0) {
      throw new Error(
        `[daroyan] Invalid route ${file}: cannot mix a default sub-router export with named method exports (${routeExports.methods.join(
          ", ",
        )}).`,
      );
    }

    if (routeExports.hasDefault && !routeExports.defaultIsHono) {
      throw new Error(
        `[daroyan] Invalid route ${file}: the default export must be a chained Hono sub-router.`,
      );
    }

    if (routeExports.defaultHasUnchainedRoutes) {
      throw new Error(
        `[daroyan] Invalid route ${file}: default sub-router routes must be chained and assigned so Hono retains their RPC schema.`,
      );
    }

    if (routeExports.methods.length === 0 && !routeExports.hasDefault) {
      options.warn?.(
        `[daroyan] Ignoring ${file}: the route file has no supported method export. Export one of ${HTTP_METHODS.join(
          ", ",
        )}.`,
      );
      continue;
    }

    const filenameParameters = routeParameterNames(path);
    for (const schemaParameters of routeExports.parameterSchemas) {
      if (!sameStringSet(filenameParameters, schemaParameters)) {
        options.warn?.(
          `[daroyan] ${file} has a parameter schema declaring [${schemaParameters.join(
            ", ",
          )}], but its filename path ${path} declares [${filenameParameters.join(", ")}].`,
        );
      }
    }

    routes.push({
      file,
      kind: routeExports.hasDefault ? "sub-router" : "methods",
      methods: routeExports.methods,
      middleware: middleware
        .filter((middlewareFile) => isWithin(dirname(middlewareFile), file))
        .sort((left, right) => left.length - right.length),
      path,
    });
  }

  return {
    middleware: middleware.map((file) => ({
      file,
      path: routePath(routesDirectory, resolve(dirname(file), "index.ts")),
    })),
    routes: routes.sort(compareRoutes),
  };
}

async function validateMiddlewareModule(file: string): Promise<void> {
  const source = await readFile(file, "utf8");
  const ast = parseModule(file, source);
  const middlewareBundles = new Set<string>();
  const middlewareFactories = new Set<string>();
  let hasValidDefault = false;

  for (const statement of ast.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }

    for (const specifier of statement.specifiers) {
      if (
        specifier.type === "ImportSpecifier" &&
        specifier.imported.type === "Identifier" &&
        specifier.imported.name === "defineMiddleware"
      ) {
        middlewareFactories.add(specifier.local.name);
      }
    }
  }

  for (const statement of ast.body) {
    const statementDeclaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (statementDeclaration?.type !== "VariableDeclaration") {
      continue;
    }

    for (const declaration of statementDeclaration.declarations) {
      if (
        declaration.id.type === "Identifier" &&
        isHandlerBundleExpression(declaration.init, middlewareFactories, middlewareBundles)
      ) {
        middlewareBundles.add(declaration.id.name);
      }
    }
  }

  for (const statement of ast.body) {
    if (statement.type === "ExportDefaultDeclaration") {
      hasValidDefault = isHandlerBundleExpression(
        statement.declaration,
        middlewareFactories,
        middlewareBundles,
      );
      break;
    }

    if (statement.type !== "ExportNamedDeclaration" || statement.source !== null) {
      continue;
    }

    for (const specifier of statement.specifiers) {
      const exportedName =
        specifier.exported.type === "Identifier"
          ? specifier.exported.name
          : String(specifier.exported.value);
      const localName =
        specifier.local.type === "Identifier"
          ? specifier.local.name
          : String(specifier.local.value);

      if (exportedName === "default" && middlewareBundles.has(localName)) {
        hasValidDefault = true;
      }
    }
  }

  if (!hasValidDefault) {
    throw new Error(
      `[daroyan] Invalid directory middleware ${file}: the default export must use defineMiddleware() to return a non-empty middleware tuple with at least one middleware.`,
    );
  }
}

export function validateRoutes(routes: Route[], root: string): void {
  for (let leftIndex = 0; leftIndex < routes.length; leftIndex += 1) {
    const left = routes[leftIndex];

    for (let rightIndex = leftIndex + 1; rightIndex < routes.length; rightIndex += 1) {
      const right = routes[rightIndex];
      const sameShape = routeShape(left.path) === routeShape(right.path);
      const subRouterOverlap = reservesPath(left, right.path) || reservesPath(right, left.path);

      if (!sameShape && !subRouterOverlap) {
        continue;
      }

      if (subRouterOverlap) {
        const owner = reservesPath(left, right.path) ? left : right;
        const descendant = owner === left ? right : left;

        throw new Error(
          [
            `[daroyan] Route namespace conflict at ${JSON.stringify(owner.path)}:`,
            `- ${toProjectPath(root, owner.file)}`,
            `- ${toProjectPath(root, descendant.file)}`,
            `The default sub-router at ${owner.path} owns its complete mount namespace.`,
          ].join("\n"),
        );
      }

      throw new Error(
        [
          `[daroyan] Route conflict at ${JSON.stringify(sameShape ? left.path : `${left.path} ↔ ${right.path}`)}:`,
          `- ${toProjectPath(root, left.file)}`,
          `- ${toProjectPath(root, right.file)}`,
        ].join("\n"),
      );
    }
  }
}

function matchesIgnoredRouteFile(
  routesDirectory: string,
  file: string,
  patterns: string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) {
    return false;
  }

  const routeRelativeFile = relative(routesDirectory, file).split(sep).join("/");
  return patterns.some((pattern) => minimatch(routeRelativeFile, pattern));
}

function isIgnoredRouteFile(routesDirectory: string, file: string): boolean {
  const basename = file.split(sep).at(-1) ?? "";
  const supportedExtension = basename.endsWith(".ts") || basename.endsWith(".js");

  return (
    !supportedExtension ||
    basename.startsWith("_") ||
    basename.startsWith(".") ||
    basename.endsWith(".d.ts") ||
    /\.(?:test|spec)\./.test(basename) ||
    isInIgnoredDirectory(routesDirectory, file)
  );
}

function isInIgnoredDirectory(routesDirectory: string, file: string): boolean {
  const segments = relative(routesDirectory, dirname(file)).split(sep);
  return segments.some(
    (segment) =>
      segment.startsWith(".") ||
      segment === "__tests__" ||
      segment === "__fixtures__" ||
      segment === "+types",
  );
}

function isWithin(directory: string, file: string): boolean {
  const path = relative(directory, file);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`);
}

async function readRouteExports(file: string): Promise<{
  defaultIsHono: boolean;
  defaultHasUnchainedRoutes: boolean;
  hasDefault: boolean;
  invalidMethods: Route["methods"];
  methods: Route["methods"];
  parameterSchemas: string[][];
}> {
  const source = await readFile(file, "utf8");
  const ast = parseModule(file, source);
  const exports = new Set<string>();
  const handlerBundles = new Set<string>();
  const handlerFactories = new Set<string>();
  const methodBundleNames = new Map<Route["methods"][number], string>();
  const parameterSchemasByBundle = new Map<string, string[][]>();
  const parameterSchemaShapes = new Map<string, string[]>();
  const validatorFactories = new Set<string>();
  const honoConstructors = new Set<string>();
  const honoValues = new Set<string>();
  const invalidMethods = new Set<Route["methods"][number]>();
  let hasDefault = false;
  let defaultIsHono = false;
  let defaultHonoName: string | undefined;

  for (const statement of ast.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }

    for (const specifier of statement.specifiers) {
      if (
        specifier.type === "ImportSpecifier" &&
        specifier.imported.type === "Identifier" &&
        specifier.imported.name === "Hono"
      ) {
        honoConstructors.add(specifier.local.name);
      }
      if (
        specifier.type === "ImportSpecifier" &&
        specifier.imported.type === "Identifier" &&
        specifier.imported.name === "defineHandler"
      ) {
        handlerFactories.add(specifier.local.name);
      }
      if (
        specifier.type === "ImportSpecifier" &&
        specifier.imported.type === "Identifier" &&
        specifier.imported.name === "zValidator"
      ) {
        validatorFactories.add(specifier.local.name);
      }
    }
  }

  for (const statement of ast.body) {
    const statementDeclaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (statementDeclaration?.type !== "VariableDeclaration") {
      continue;
    }

    for (const declaration of statementDeclaration.declarations) {
      if (declaration.id.type === "Identifier") {
        const schemaKeys = objectSchemaKeys(declaration.init, parameterSchemaShapes);
        if (schemaKeys) {
          parameterSchemaShapes.set(declaration.id.name, schemaKeys);
        }
      }
      if (
        declaration.id.type === "Identifier" &&
        isHonoExpression(declaration.init, honoConstructors, honoValues)
      ) {
        honoValues.add(declaration.id.name);
      }
      if (
        declaration.id.type === "Identifier" &&
        isHandlerBundleExpression(declaration.init, handlerFactories, handlerBundles)
      ) {
        handlerBundles.add(declaration.id.name);
        parameterSchemasByBundle.set(
          declaration.id.name,
          parameterSchemasInExpression(declaration.init, validatorFactories, parameterSchemaShapes),
        );
      }
    }
  }

  for (const statement of ast.body) {
    if (statement.type === "ExportDefaultDeclaration") {
      hasDefault = true;
      defaultIsHono = isHonoExpression(statement.declaration, honoConstructors, honoValues);
      if (statement.declaration.type === "Identifier") {
        defaultHonoName = statement.declaration.name;
      }
      continue;
    }

    if (statement.type !== "ExportNamedDeclaration") {
      continue;
    }

    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ExportSpecifier") {
        continue;
      }

      const name =
        specifier.exported.type === "Identifier"
          ? specifier.exported.name
          : String(specifier.exported.value);
      if (name === "default") {
        hasDefault = true;
        const localName =
          specifier.local.type === "Identifier"
            ? specifier.local.name
            : String(specifier.local.value);
        if (statement.source === null && honoValues.has(localName)) {
          defaultIsHono = true;
          defaultHonoName = localName;
        }
      } else {
        exports.add(name);
        if (HTTP_METHODS.includes(name as Route["methods"][number]) && statement.source !== null) {
          invalidMethods.add(name as Route["methods"][number]);
        } else if (HTTP_METHODS.includes(name as Route["methods"][number])) {
          const localName =
            specifier.local.type === "Identifier"
              ? specifier.local.name
              : String(specifier.local.value);
          methodBundleNames.set(name as Route["methods"][number], localName);
          if (!handlerBundles.has(localName)) {
            invalidMethods.add(name as Route["methods"][number]);
          }
        }
      }
    }

    if (
      statement.declaration?.type === "FunctionDeclaration" ||
      statement.declaration?.type === "ClassDeclaration" ||
      statement.declaration?.type === "TSEnumDeclaration"
    ) {
      const name = statement.declaration.id?.name;
      if (name && HTTP_METHODS.includes(name as Route["methods"][number])) {
        exports.add(name);
        invalidMethods.add(name as Route["methods"][number]);
      }
    }

    if (statement.declaration?.type === "VariableDeclaration") {
      for (const declaration of statement.declaration.declarations) {
        if (declaration.id.type === "Identifier") {
          exports.add(declaration.id.name);
          if (
            HTTP_METHODS.includes(declaration.id.name as Route["methods"][number]) &&
            !handlerBundles.has(declaration.id.name)
          ) {
            invalidMethods.add(declaration.id.name as Route["methods"][number]);
          }
          if (HTTP_METHODS.includes(declaration.id.name as Route["methods"][number])) {
            methodBundleNames.set(
              declaration.id.name as Route["methods"][number],
              declaration.id.name,
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
      ast.body.some((statement) => isUnchainedRouteMutation(statement, defaultHonoName)),
    hasDefault,
    invalidMethods: HTTP_METHODS.filter((method) => invalidMethods.has(method)),
    methods: HTTP_METHODS.filter((method) => exports.has(method)),
    parameterSchemas: HTTP_METHODS.flatMap((method) =>
      exports.has(method)
        ? (parameterSchemasByBundle.get(methodBundleNames.get(method) ?? method) ?? [])
        : [],
    ),
  };
}

const HONO_ROUTE_METHODS = new Set([
  "all",
  "delete",
  "get",
  "head",
  "on",
  "options",
  "patch",
  "post",
  "put",
  "route",
]);

function isUnchainedRouteMutation(value: unknown, honoName: string): boolean {
  const statement = asNode(value);
  if (statement?.type !== "ExpressionStatement") {
    return false;
  }

  const expression = asNode(statement.expression);
  const callee = asNode(expression?.callee);
  const object = asNode(callee?.object);
  const property = asNode(callee?.property);

  return (
    expression?.type === "CallExpression" &&
    callee?.type === "MemberExpression" &&
    object?.type === "Identifier" &&
    object.name === honoName &&
    property?.type === "Identifier" &&
    property.name !== undefined &&
    HONO_ROUTE_METHODS.has(property.name)
  );
}

type NodeView = {
  callee?: unknown;
  expression?: unknown;
  name?: string;
  object?: unknown;
  property?: unknown;
  type: string;
};

function isHonoExpression(
  value: unknown,
  constructors: Set<string>,
  instances: Set<string>,
): boolean {
  const node = asNode(value);
  if (!node) {
    return false;
  }

  if (node.type === "Identifier") {
    return node.name !== undefined && instances.has(node.name);
  }
  if (node.type === "NewExpression") {
    const callee = asNode(node.callee);
    return (
      callee?.type === "Identifier" && callee.name !== undefined && constructors.has(callee.name)
    );
  }
  if (node.type === "CallExpression") {
    const callee = asNode(node.callee);
    return callee?.type === "MemberExpression"
      ? isHonoExpression(callee.object, constructors, instances)
      : false;
  }
  if (
    node.type === "ChainExpression" ||
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression"
  ) {
    return isHonoExpression(node.expression, constructors, instances);
  }

  return false;
}

function isHandlerBundleExpression(
  value: unknown,
  factories: Set<string>,
  bundles: Set<string>,
): boolean {
  const node = asNode(value);
  if (!node) {
    return false;
  }

  if (node.type === "Identifier") {
    return node.name !== undefined && bundles.has(node.name);
  }
  if (node.type === "ArrayExpression") {
    const elements = (node as NodeView & { elements?: unknown[] }).elements ?? [];
    return elements.length > 0 && elements.every(isHandlerValue);
  }
  if (node.type === "CallExpression") {
    const callee = asNode(node.callee);
    const arguments_ = (node as NodeView & { arguments?: unknown[] }).arguments ?? [];
    return (
      callee?.type === "Identifier" &&
      callee.name !== undefined &&
      factories.has(callee.name) &&
      arguments_.length > 0 &&
      arguments_.every(isHandlerValue)
    );
  }
  if (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression"
  ) {
    return isHandlerBundleExpression(node.expression, factories, bundles);
  }

  return false;
}

function isHandlerValue(value: unknown): boolean {
  const node = asNode(value);
  if (!node) {
    return false;
  }

  if (
    node.type === "ArrowFunctionExpression" ||
    node.type === "CallExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "Identifier" ||
    node.type === "MemberExpression"
  ) {
    return true;
  }
  if (node.type === "SpreadElement") {
    return isHandlerValue((node as NodeView & { argument?: unknown }).argument);
  }
  if (
    node.type === "TSAsExpression" ||
    node.type === "TSSatisfiesExpression" ||
    node.type === "TSNonNullExpression"
  ) {
    return isHandlerValue(node.expression);
  }

  return false;
}

function asNode(value: unknown): NodeView | undefined {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return undefined;
  }

  return value as NodeView;
}

function parseModule(file: string, source: string): ReturnType<typeof parseAst> {
  try {
    return parseAst(source, { lang: "ts" });
  } catch (error) {
    throw new Error(
      `[daroyan] Failed to parse route module ${file}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

function parameterSchemasInExpression(
  value: unknown,
  validatorFactories: Set<string>,
  namedSchemas: Map<string, string[]>,
): string[][] {
  const schemas: string[][] = [];

  visitNode(value, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }

    const callee = asNode(node.callee);
    const arguments_ = (node as NodeView & { arguments?: unknown[] }).arguments ?? [];
    const target = asNode(arguments_[0]) as (NodeView & { value?: unknown }) | undefined;
    if (
      callee?.type !== "Identifier" ||
      callee.name === undefined ||
      !validatorFactories.has(callee.name) ||
      target?.type !== "Literal" ||
      target.value !== "param"
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
  namedSchemas: Map<string, string[]>,
): string[] | undefined {
  const schema = asNode(value);
  if (schema?.type === "Identifier" && schema.name !== undefined) {
    return namedSchemas.get(schema.name);
  }
  if (schema?.type !== "CallExpression") {
    return undefined;
  }

  const callee = asNode(schema.callee);
  const property = asNode(callee?.property);
  const arguments_ = (schema as NodeView & { arguments?: unknown[] }).arguments ?? [];
  const shape = asNode(arguments_[0]) as (NodeView & { properties?: unknown[] }) | undefined;
  if (
    callee?.type !== "MemberExpression" ||
    property?.type !== "Identifier" ||
    property.name !== "object" ||
    shape?.type !== "ObjectExpression"
  ) {
    return undefined;
  }

  const keys: string[] = [];
  for (const value of shape.properties ?? []) {
    const field = asNode(value) as (NodeView & { computed?: boolean; key?: unknown }) | undefined;
    const key = asNode(field?.key) as (NodeView & { value?: unknown }) | undefined;
    if (field?.type !== "Property" || field.computed || !key) {
      return undefined;
    }
    if (key.type === "Identifier" && key.name !== undefined) {
      keys.push(key.name);
    } else if (key.type === "Literal" && typeof key.value === "string") {
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
    if (key === "span" || key === "start" || key === "end") {
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

function routeParameterNames(path: string): string[] {
  return [...path.matchAll(/:([^/{}]+)(?:\{\.\+\})?/g)].map((match) => match[1]);
}

function sameStringSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value)) &&
    right.every((value) => left.includes(value))
  );
}

function routePath(routesDirectory: string, file: string): string {
  const relativeFile = relative(routesDirectory, file).split(sep).join("/");
  const segments = relativeFile.replace(/\.[^.]+$/, "").split("/");

  if (segments.at(-1) === "index") {
    segments.pop();
  }

  const catchAllIndex = segments.findIndex((segment) => segment.startsWith("$..."));
  if (catchAllIndex !== -1 && catchAllIndex !== segments.length - 1) {
    throw new Error(
      `[daroyan] Invalid route ${file}: catch-all segment ${JSON.stringify(
        segments[catchAllIndex],
      )} must be final.`,
    );
  }

  const parameters = new Set<string>();
  for (const segment of segments) {
    if (!segment.startsWith("$")) {
      continue;
    }

    const parameter = segment.startsWith("$...") ? segment.slice(4) : segment.slice(1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parameter)) {
      throw new Error(
        `[daroyan] Invalid route ${file}: invalid dynamic parameter name ${JSON.stringify(
          parameter,
        )}. Use letters, numbers, and underscores, starting with a letter or underscore.`,
      );
    }
    if (parameters.has(parameter)) {
      throw new Error(
        `[daroyan] Invalid route ${file}: duplicate dynamic parameter ${JSON.stringify(
          parameter,
        )}. Every filename parameter in a route must have a unique name.`,
      );
    }
    parameters.add(parameter);
  }

  const path = segments.map(routeSegment).join("/");
  return path ? `/${path}` : "/";
}

function routeSegment(segment: string): string {
  if (segment.startsWith("$...")) {
    return `:${segment.slice(4)}{.+}`;
  }

  if (segment.startsWith("$")) {
    return `:${segment.slice(1)}`;
  }

  return segment;
}

function reservesPath(route: Route, path: string): boolean {
  if (route.kind !== "sub-router") {
    return false;
  }

  const ownerSegments = route.path.split("/").filter(Boolean);
  const candidateSegments = path.split("/").filter(Boolean);
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
    if (!isDynamicSegment(owner) && !isDynamicSegment(candidate) && owner !== candidate) {
      return false;
    }
  }

  return true;
}

function routeShape(path: string): string {
  return path.replace(/:[^/{}]+\{\.\+\}/g, "$catch-all").replace(/:[^/{}]+/g, "$dynamic");
}

function isCatchAllSegment(segment: string): boolean {
  return segment.startsWith(":") && segment.endsWith("{.+}");
}

function isDynamicSegment(segment: string): boolean {
  return segment.startsWith(":");
}

function compareRoutes(left: Route, right: Route): number {
  const leftSegments = left.path.split("/").filter(Boolean);
  const rightSegments = right.path.split("/").filter(Boolean);

  for (let index = 0; index < Math.max(leftSegments.length, rightSegments.length); index += 1) {
    const priorityDifference =
      segmentPriority(leftSegments[index]) - segmentPriority(rightSegments[index]);

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
  if (segment.endsWith("{.+}")) {
    return 2;
  }
  if (segment.startsWith(":")) {
    return 1;
  }
  return 0;
}
