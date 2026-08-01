import type { NodeView } from '../ast.ts';
import { toChildNodes, toNodeView } from '../ast.ts';

export function isValidatorImport(
  source: string,
  importedName: string
): boolean {
  if (source === 'hono/validator' || /^@hono\/.+-validator$/.test(source)) {
    return true;
  }

  return importedName === 'validator' || importedName.endsWith('Validator');
}

/** The parameter keys every `("param", schema)` validator in an expression declares. */
export function parameterSchemasIn(
  value: unknown,
  validators: Set<string>,
  namedSchemas: Map<string, string[]>
): string[][] {
  const schemas: string[][] = [];

  visitNodes(value, (node) => {
    if (node.type !== 'CallExpression') {
      return;
    }

    const callee = toNodeView(node.callee);
    const arguments_ = node.arguments ?? [];
    const target = toNodeView(arguments_[0]);
    if (
      callee?.type !== 'Identifier' ||
      callee.name === undefined ||
      !validators.has(callee.name) ||
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

export function objectSchemaKeys(
  value: unknown,
  namedSchemas: Map<string, string[]>
): string[] | undefined {
  const schema = toNodeView(value);
  if (schema?.type === 'Identifier' && schema.name !== undefined) {
    return namedSchemas.get(schema.name);
  }
  if (schema?.type !== 'CallExpression') {
    return undefined;
  }

  const callee = toNodeView(schema.callee);
  const property = toNodeView(callee?.property);
  const arguments_ = schema.arguments ?? [];
  const shape = toNodeView(arguments_[0]);
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
    const field = toNodeView(value);
    const key = toNodeView(field?.key);
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

function visitNodes(value: unknown, visit: (node: NodeView) => void): void {
  const node = toNodeView(value);
  if (!node) {
    return;
  }

  visit(node);
  for (const child of toChildNodes(node)) {
    visitNodes(child, visit);
  }
}
