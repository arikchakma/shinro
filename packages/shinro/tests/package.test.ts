import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { expect, test } from 'vite-plus/test';

const run = promisify(execFile);

test('public package subpaths expose matching runtime and declaration files', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as {
    exports: Record<string, { import: string; types: string } | string>;
  };

  expect(packageJson.exports).toMatchObject({
    '.': {
      import: './dist/index.mjs',
      types: './dist/index.d.mts',
    },
    './app': {
      import: './dist/app.mjs',
      types: './dist/app.d.mts',
    },
    './tsconfig': './tsconfig.base.json',
    './package.json': './package.json',
  });
});

test('published dependency ranges resolve without the workspace', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  // `catalog:` and `workspace:` are pnpm protocols that only `pnpm publish`
  // rewrites. Installers see whatever the tarball holds, so a consumer-facing
  // range has to be a literal one no matter which client publishes.
  const specifiers = [
    ...Object.entries(packageJson.dependencies ?? {}),
    ...Object.entries(packageJson.peerDependencies ?? {}),
  ];

  expect(specifiers.length).toBeGreaterThan(0);
  for (const [name, specifier] of specifiers) {
    expect(`${name}@${specifier}`).toMatch(/@[\d^~><=*]/);
  }
});

test('the package build does not leak the fixture application environment', async () => {
  const packageRoot = new URL('..', import.meta.url);

  await run(
    new URL('../node_modules/.bin/vp', import.meta.url).pathname,
    ['pack'],
    {
      cwd: packageRoot.pathname,
    }
  );

  const declaration = await readFile(
    new URL('../dist/app.d.mts', import.meta.url),
    'utf8'
  );
  // Doc comments are stripped first: they legitimately show an example env, and
  // the leak this guards against would be in the declarations themselves.
  const declared = declaration.replace(/\/\*[\s\S]*?\*\//g, '');

  expect(declared).not.toContain('tests/fixtures');
  expect(declared).not.toContain('requestId');
  // Handler and middleware positions both resolve their environment through
  // `RouteEnv`, so neither carries a resolved environment from whichever
  // application happened to run the build.
  expect(declared).toContain('Handler<RouteEnv<Route>');
  expect(declared).toContain('E extends Env = RouteEnv<Route>');
  // `ShinroEnv` ships empty and the project fills it in by augmentation, so a
  // member here would mean a local environment had been baked into the package.
  expect(declared).toMatch(/interface ShinroEnv extends Env \{\s*\}/);
});
