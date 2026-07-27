import { parseSync } from 'oxc-parser';

/**
 * The subset of an oxc AST node the scanner reads. Route and app modules are
 * inspected structurally rather than type checked, so a narrow structural view
 * keeps the traversal helpers independent of the parser's full node types.
 *
 * Moved from `server/ast.ts`. One change, and it is the point of the refactor:
 * `parseSync` comes from `oxc-parser` directly instead of being re-exported
 * through `vite`, so nothing in the core imports a bundler.
 */
export type NodeView = {
  argument?: unknown;
  arguments?: unknown[];
  body?: unknown;
  callee?: unknown;
  declaration?: unknown;
  elements?: unknown[];
  expression?: unknown;
  name?: string;
  object?: unknown;
  property?: unknown;
  type: string;
};

export function toNodeView(value: unknown): NodeView | undefined {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return undefined;
  }

  return value as NodeView;
}

/** Expressions that wrap a value without changing what it evaluates to. */
const TRANSPARENT_EXPRESSIONS = new Set([
  'ChainExpression',
  'TSAsExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
]);

export function isTransparentExpression(node: NodeView): boolean {
  return TRANSPARENT_EXPRESSIONS.has(node.type);
}

/**
 * Whether an expression evaluates to a Hono instance: `new Hono()`, a
 * previously bound instance, or any chained method call on one.
 */
export function isHonoExpression(
  value: unknown,
  constructors: Set<string>,
  instances: Set<string>
): boolean {
  const node = toNodeView(value);
  if (!node) {
    return false;
  }

  if (node.type === 'Identifier') {
    return node.name !== undefined && instances.has(node.name);
  }
  if (node.type === 'NewExpression') {
    const callee = toNodeView(node.callee);
    return (
      callee?.type === 'Identifier' &&
      callee.name !== undefined &&
      constructors.has(callee.name)
    );
  }
  if (node.type === 'CallExpression') {
    const callee = toNodeView(node.callee);
    return callee?.type === 'MemberExpression'
      ? isHonoExpression(callee.object, constructors, instances)
      : false;
  }
  if (isTransparentExpression(node)) {
    return isHonoExpression(node.expression, constructors, instances);
  }

  return false;
}

/**
 * Collects the local names bound to a named import. `fromSource` narrows the
 * match to the modules that count, so an unrelated local that happens to share a
 * name cannot be mistaken for the real binding. It takes a predicate rather than
 * a literal because the app may reach the generated router through
 * `#shinro/routes` or through a relative path, and both are supported spellings.
 */
export function localNamesForImport(
  ast: ReturnType<typeof parseModule>,
  importedName: string,
  fromSource?: (source: string) => boolean
): Set<string> {
  const locals = new Set<string>();

  for (const statement of ast.body) {
    if (statement.type !== 'ImportDeclaration') {
      continue;
    }

    const source =
      typeof statement.source.value === 'string' ? statement.source.value : '';
    if (fromSource !== undefined && !fromSource(source)) {
      continue;
    }

    for (const specifier of statement.specifiers) {
      if (
        specifier.type === 'ImportSpecifier' &&
        specifier.imported.type === 'Identifier' &&
        specifier.imported.name === importedName
      ) {
        locals.add(specifier.local.name);
      }
    }
  }

  return locals;
}

export function containsCallTo(value: unknown, names: Set<string>): boolean {
  const node = toNodeView(value);
  if (!node || names.size === 0) {
    return false;
  }

  if (node.type === 'CallExpression') {
    const callee = toNodeView(node.callee);
    if (
      callee?.type === 'Identifier' &&
      callee.name !== undefined &&
      names.has(callee.name)
    ) {
      return true;
    }
  }

  return Object.entries(node).some(
    ([key, child]) =>
      key !== 'span' &&
      (Array.isArray(child)
        ? child.some((item) => containsCallTo(item, names))
        : containsCallTo(child, names))
  );
}

export function specifierNames(specifier: {
  exported: { name?: string; value?: unknown; type: string };
  local: { name?: string; value?: unknown; type: string };
}): { exported: string; local: string } {
  return {
    exported:
      specifier.exported.type === 'Identifier'
        ? (specifier.exported.name ?? '')
        : String(specifier.exported.value),
    local:
      specifier.local.type === 'Identifier'
        ? (specifier.local.name ?? '')
        : String(specifier.local.value),
  };
}

export function parseModule(
  file: string,
  source: string,
  kind: 'app module' | 'route module'
): ReturnType<typeof parseSync>['program'] {
  const result = parseSync(file, source, { lang: 'ts' });
  if (result.errors.length > 0) {
    throw new Error(
      `[shinro] Failed to parse ${kind} ${file}:\n${result.errors
        .map((error) => error.codeframe ?? error.message)
        .join('\n')}`
    );
  }

  return result.program;
}
