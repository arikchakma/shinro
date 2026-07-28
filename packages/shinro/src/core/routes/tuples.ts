import { isTransparentExpression, toNodeView } from '../ast.ts';

/**
 * How many handlers an expression contributes, or `undefined` when it is not a
 * handler tuple at all. `null` means it is one but the length is unknowable —
 * a spread element, or an alias of something unresolved — in which case the
 * arity guard stays quiet rather than guessing at a limit.
 */
export function handlerCount(
  value: unknown,
  factories: Set<string>,
  tuples: Map<string, number | null>
): number | null | undefined {
  const node = toNodeView(value);
  if (!node) {
    return undefined;
  }

  if (node.type === 'Identifier') {
    return node.name !== undefined && tuples.has(node.name)
      ? tuples.get(node.name)
      : undefined;
  }
  if (node.type === 'ArrayExpression') {
    const elements = node.elements ?? [];
    return elements.length > 0 && elements.every(isHandlerValue)
      ? lengthUnlessSpread(elements)
      : undefined;
  }
  if (node.type === 'CallExpression') {
    const callee = toNodeView(node.callee);
    const arguments_ = node.arguments ?? [];
    return callee?.type === 'Identifier' &&
      callee.name !== undefined &&
      factories.has(callee.name) &&
      arguments_.length > 0 &&
      arguments_.every(isHandlerValue)
      ? lengthUnlessSpread(arguments_)
      : undefined;
  }
  if (isTransparentExpression(node)) {
    return handlerCount(node.expression, factories, tuples);
  }

  return undefined;
}

/**
 * Whether an expression could be a handler tuple. Deliberately lenient: a method
 * export is spread into Hono (`...GET`), so a value that *provably* is not a
 * tuple is worth rejecting early with a precise message, and everything else — a
 * project wrapper, a shared tuple, a helper call — is left to TypeScript, which
 * checks spreadability exactly and reports it against the user's own source
 * rather than against generated code.
 */
export function couldBeHandlerTuple(
  value: unknown,
  factories: Set<string>
): boolean {
  const node = toNodeView(value);
  if (!node) {
    return false;
  }

  if (isTransparentExpression(node)) {
    return couldBeHandlerTuple(node.expression, factories);
  }

  if (node.type === 'ArrayExpression') {
    const elements = node.elements ?? [];
    return elements.length > 0 && elements.every(isHandlerValue);
  }
  if (node.type === 'CallExpression') {
    const callee = toNodeView(node.callee);
    const arguments_ = node.arguments ?? [];
    const isFactoryCall =
      callee?.type === 'Identifier' &&
      callee.name !== undefined &&
      factories.has(callee.name);

    return (
      !isFactoryCall ||
      (arguments_.length > 0 && arguments_.every(isHandlerValue))
    );
  }

  return (
    node.type !== 'ArrowFunctionExpression' &&
    node.type !== 'ClassExpression' &&
    node.type !== 'FunctionExpression' &&
    node.type !== 'Literal' &&
    node.type !== 'NewExpression' &&
    node.type !== 'ObjectExpression' &&
    node.type !== 'TemplateLiteral'
  );
}

function isHandlerValue(value: unknown): boolean {
  const node = toNodeView(value);
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
    return isHandlerValue(node.argument);
  }
  if (isTransparentExpression(node)) {
    return isHandlerValue(node.expression);
  }

  return false;
}

function lengthUnlessSpread(elements: unknown[]): number | null {
  return elements.some(
    (element) => toNodeView(element)?.type === 'SpreadElement'
  )
    ? null
    : elements.length;
}
