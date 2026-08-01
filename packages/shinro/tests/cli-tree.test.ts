import { expect, test } from 'vite-plus/test';

import { unknownOptions } from '../src/cli/args.ts';
import { routeTree } from '../src/cli/tree.ts';
import type { ManifestRoute } from '../src/core/generate.ts';

function methods(
  path: string,
  verbs: string[],
  middleware: string[] = []
): ManifestRoute {
  return {
    file: `src/routes${path}.ts`,
    kind: 'methods',
    methods: verbs,
    middleware,
    path,
  };
}

test('the tree nests routes by path segment, in a stable order', () => {
  const lines = routeTree([
    methods('/health', ['GET', 'POST']),
    methods('/api', ['GET']),
    methods('/api/users', ['GET']),
    methods('/api/users/:id', ['GET', 'PATCH']),
  ]);

  expect(lines.join('\n')).toBe(
    [
      '  /',
      '  ├─ api        GET',
      '  │  └─ users   GET',
      '  │     └─ :id  GET PATCH',
      '  └─ health     GET POST',
    ].join('\n')
  );
  expect(routeTree([methods('/', ['GET'])])[0]).toBe('  /  GET');
  expect(routeTree([methods('/a', ['GET']), methods('/b', ['GET'])])).toEqual(
    routeTree([methods('/b', ['GET']), methods('/a', ['GET'])])
  );
});

test('a segment no route lands on still holds its children up', () => {
  const lines = routeTree([
    methods('/teams/:teamId/members/:memberId', ['GET']),
    {
      file: 'src/routes/admin.ts',
      kind: 'sub-router',
      middleware: [],
      mountPath: '/admin',
    },
  ]);

  // `teams`, `:teamId` and `members` have no methods of their own. Dropping
  // them would leave the leaf indented under nothing.
  expect(lines.join('\n')).toContain(
    [
      '  ├─ admin               sub-router',
      '  └─ teams',
      '     └─ :teamId',
      '        └─ members',
      '           └─ :memberId  GET',
    ].join('\n')
  );
});

test('unknown options are named and known ones are not', () => {
  expect(
    unknownOptions(['generate', '--force'], ['--check', '--watch'])
  ).toEqual(['--force']);
  expect(
    unknownOptions(['generate', '--watch'], ['--check', '--watch'])
  ).toEqual([]);
  // citty negates booleans itself, and `--flag=value` is the same flag.
  expect(
    unknownOptions(['--no-check', '--watch=true'], ['--check', '--watch'])
  ).toEqual([]);
  expect(unknownOptions(['--help', '-h'], ['--check'])).toEqual([]);
});
