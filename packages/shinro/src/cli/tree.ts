import type { ManifestRoute } from '../core/generate.ts';
import { bold, dim, method } from './style.ts';

type Node = {
  children: Map<string, Node>;
  methods: string[];
  sub: boolean;
};

export function routeTree(routes: ManifestRoute[]): string[] {
  const root = node();

  for (const route of routes) {
    const path = route.path ?? route.mountPath ?? '/';
    const target = path
      .split('/')
      .filter(Boolean)
      .reduce((parent, segment) => {
        const existing = parent.children.get(segment) ?? node();
        parent.children.set(segment, existing);
        return existing;
      }, root);

    target.methods = route.methods ?? [];
    target.sub = route.kind === 'sub-router';
  }

  const rows = [{ depth: '', label: '/', node: root }, ...walk(root, '')];
  const width = Math.max(
    ...rows.map((row) => row.depth.length + row.label.length)
  );

  return rows.map((row) => {
    const pad = ' '.repeat(width - row.depth.length - row.label.length);
    const verbs = row.node.sub
      ? dim('sub-router')
      : row.node.methods.map((verb) => method(verb)).join(' ');

    return `  ${dim(row.depth)}${bold(row.label)}${pad}${
      verbs === '' ? '' : `  ${verbs}`
    }`.trimEnd();
  });
}

function node(): Node {
  return { children: new Map(), methods: [], sub: false };
}

function walk(
  parent: Node,
  indent: string
): { depth: string; label: string; node: Node }[] {
  const entries = [...parent.children.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  );

  return entries.flatMap(([segment, child], index) => {
    const last = index === entries.length - 1;

    return [
      {
        depth: `${indent}${last ? '└─ ' : '├─ '}`,
        label: segment,
        node: child,
      },
      ...walk(child, `${indent}${last ? '   ' : '│  '}`),
    ];
  });
}
