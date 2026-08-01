import { parseSync } from 'oxc-parser';

export type NodeView = {
  argument?: unknown;
  arguments?: unknown[];
  body?: unknown;
  callee?: unknown;
  computed?: boolean;
  declaration?: unknown;
  declarations?: unknown[];
  elements?: unknown[];
  expression?: unknown;
  init?: unknown;
  key?: unknown;
  name?: string;
  object?: unknown;
  properties?: unknown[];
  property?: unknown;
  value?: unknown;
  type: string;
};

export function toNodeView(value: unknown): NodeView | undefined {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return undefined;
  }

  return value as NodeView;
}

/** Positional metadata every node carries, which is never a child node. */
const POSITION_KEYS = new Set(['end', 'span', 'start']);

export function* toChildNodes(node: NodeView): Generator<unknown> {
  for (const [key, child] of Object.entries(node)) {
    if (POSITION_KEYS.has(key)) {
      continue;
    }
    if (Array.isArray(child)) {
      yield* child;
    } else {
      yield child;
    }
  }
}

/** Expressions that wrap a value without changing what it evaluates to. */
const WRAPPER_EXPRESSIONS = new Set([
  'ChainExpression',
  'TSAsExpression',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
]);

export function isWrapperExpression(node: NodeView): boolean {
  return WRAPPER_EXPRESSIONS.has(node.type);
}

export function isHonoInstance(
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
      ? isHonoInstance(callee.object, constructors, instances)
      : false;
  }
  if (isWrapperExpression(node)) {
    return isHonoInstance(node.expression, constructors, instances);
  }

  return false;
}

export function toLocalNames(
  ast: ReturnType<typeof parseModule>,
  importedName: string,
  matchesSource?: (source: string) => boolean
): Set<string> {
  const locals = new Set<string>();

  for (const statement of ast.body) {
    if (statement.type !== 'ImportDeclaration') {
      continue;
    }

    const source =
      typeof statement.source.value === 'string' ? statement.source.value : '';
    if (matchesSource !== undefined && !matchesSource(source)) {
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

export function hasCallTo(value: unknown, names: Set<string>): boolean {
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

  for (const child of toChildNodes(node)) {
    if (hasCallTo(child, names)) {
      return true;
    }
  }

  return false;
}

export function toMethodCall(value: unknown):
  | {
      arguments: unknown[];
      method: string;
      object: string;
    }
  | undefined {
  const statement = toNodeView(value);
  if (statement?.type !== 'ExpressionStatement') {
    return undefined;
  }

  const expression = toNodeView(statement.expression);
  const callee = toNodeView(expression?.callee);
  const object = toNodeView(callee?.object);
  const property = toNodeView(callee?.property);
  if (
    expression?.type !== 'CallExpression' ||
    callee?.type !== 'MemberExpression' ||
    object?.type !== 'Identifier' ||
    object.name === undefined ||
    property?.type !== 'Identifier' ||
    property.name === undefined
  ) {
    return undefined;
  }

  return {
    arguments: expression.arguments ?? [],
    method: property.name,
    object: object.name,
  };
}

export function toSpecifierNames(specifier: {
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
