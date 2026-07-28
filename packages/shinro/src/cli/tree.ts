import { bold, dim, method } from './style.ts';

/** One entry of `.shinro/manifest.json`, which is the record of what was written. */
export type ManifestRoute = {
  file: string;
  kind: 'methods' | 'sub-router';
  methods?: string[];
  middleware: string[];
  mountPath?: string;
  path?: string;
};

type Node = {
  children: Map<string, Node>;
  methods: string[];
  sub: boolean;
};

/**
 * The route tree as a tree, which is the shape it already has — a flat list
 * makes you read `/api/users/:id` character by character to work out that it
 * sits under `/api`, and the whole point of file-based routing is that the
 * nesting is the design.
 *
 * Plain lines, printed and forgotten. There is no renderer, no component, and
 * nothing held open: this is a `console.info` that happens to draw box-drawing
 * characters, so it reads the same in a terminal, a pipe, and a CI log.
 */
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

  // Every node is kept, including the ones no route lands on. `/teams` and
  // `/teams/:teamId` carry no methods of their own, but deleting them would
  // leave `:memberId` indented under nothing.
  //
  // Labels are laid out first so the method column can be aligned against the
  // widest one. Measuring after colouring would count the escape codes.
  const rows = [{ depth: '', label: '/', node: root }, ...walk(root, '')];
  const width = Math.max(
    ...rows.map((row) => row.depth.length + row.label.length)
  );

  return rows.map((row) => {
    // The connectors are scaffolding and the segment is the content, so they
    // are styled apart — bolding the whole label made every `├─` compete with
    // the route name next to it. Padding is computed on the plain lengths and
    // appended outside both, which keeps the method column aligned.
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
      // A last child's descendants need no continuation bar above them, which
      // is the only thing that keeps a deep tree from growing a column of
      // pipes that lead nowhere.
      ...walk(child, `${indent}${last ? '   ' : '│  '}`),
    ];
  });
}
