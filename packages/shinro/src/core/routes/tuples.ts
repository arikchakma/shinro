import type { NodeView } from '../ast.ts';
import { isWrapperExpression, toNodeView } from '../ast.ts';

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
    return isHandlerList(elements) ? lengthUnlessSpread(elements) : undefined;
  }
  if (node.type === 'CallExpression') {
    const arguments_ = node.arguments ?? [];
    return isFactoryCall(node, factories) && isHandlerList(arguments_)
      ? lengthUnlessSpread(arguments_)
      : undefined;
  }
  if (isWrapperExpression(node)) {
    return handlerCount(node.expression, factories, tuples);
  }

  return undefined;
}

export function couldBeHandlerTuple(
  value: unknown,
  factories: Set<string>
): boolean {
  const node = toNodeView(value);
  if (!node) {
    return false;
  }

  if (isWrapperExpression(node)) {
    return couldBeHandlerTuple(node.expression, factories);
  }

  if (node.type === 'ArrayExpression') {
    return isHandlerList(node.elements ?? []);
  }
  if (node.type === 'CallExpression') {
    return (
      !isFactoryCall(node, factories) || isHandlerList(node.arguments ?? [])
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

/** A call to `defineHandler` or `defineMiddleware` under whatever local name. */
function isFactoryCall(node: NodeView, factories: Set<string>): boolean {
  const callee = toNodeView(node.callee);
  return (
    callee?.type === 'Identifier' &&
    callee.name !== undefined &&
    factories.has(callee.name)
  );
}

/** A non-empty list whose every element could be a handler. */
function isHandlerList(items: unknown[]): boolean {
  return items.length > 0 && items.every(isHandlerValue);
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
  if (isWrapperExpression(node)) {
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
