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
    // The two side-effecting preloads. They are the dev story, so they are part
    // of the published surface rather than an implementation detail.
    './generate': {
      import: './dist/generate.mjs',
      types: './dist/generate.d.mts',
    },
    './watch': {
      import: './dist/watch.mjs',
      types: './dist/watch.d.mts',
    },
    './tsdown': {
      import: './dist/adapters/tsdown.mjs',
      types: './dist/adapters/tsdown.d.mts',
    },
    './vite': {
      import: './dist/adapters/vite.mjs',
      types: './dist/adapters/vite.d.mts',
    },
    './tsconfig': './tsconfig.base.json',
    './tsconfig/emit': './tsconfig.emit.json',
    './package.json': './package.json',
  });
});

test('the shipped tsconfigs cover both checking and emitting', async () => {
  // The shipped configs carry comments explaining why each option is there, so
  // they are JSONC — which is exactly what a consumer's tsc accepts.
  const base = (await readJsonc('../tsconfig.base.json')) as {
    compilerOptions: Record<string, unknown>;
    include: string[];
  };
  const emit = (await readJsonc('../tsconfig.emit.json')) as {
    compilerOptions: Record<string, unknown>;
    extends: string;
  };

  // `${configDir}` is what lets a base config in node_modules express
  // project-relative paths, and it is the only reason the boilerplate can live
  // in the package rather than in every consumer's tsconfig.
  expect(base.compilerOptions.rootDirs).toEqual([
    '${configDir}',
    '${configDir}/.shinro/types',
  ]);
  expect(base.include).toContain('${configDir}/.shinro/**/*.ts');
  expect(base.compilerOptions.allowImportingTsExtensions).toBe(true);
  expect(base.compilerOptions.noEmit).toBe(true);

  // One config made "build it however you want" false for plain tsc: emitting
  // needs the generated `./x.ts` specifiers rewritten, which `noEmit` forbids.
  expect(emit.extends).toBe('./tsconfig.base.json');
  expect(emit.compilerOptions.noEmit).toBe(false);
  expect(emit.compilerOptions.rewriteRelativeImportExtensions).toBe(true);
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

async function readJsonc(path: string): Promise<unknown> {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  return JSON.parse(source.replace(/^\s*\/\/.*$/gm, '')) as unknown;
}
