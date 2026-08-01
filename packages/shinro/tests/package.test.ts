import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';

import { expect, test } from 'vite-plus/test';

const run = promisify(execFile);

test('the published package is consumable without the workspace', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  ) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  // `catalog:` and `workspace:` are pnpm protocols only `pnpm publish` rewrites,
  // and installers see whatever the tarball holds.
  const specifiers = [
    ...Object.entries(packageJson.dependencies ?? {}),
    ...Object.entries(packageJson.peerDependencies ?? {}),
  ];

  expect(specifiers.length).toBeGreaterThan(0);
  for (const [name, specifier] of specifiers) {
    expect(`${name}@${specifier}`).toMatch(/@[\d^~><=*]/);
  }

  const base = (await readJsonc('../tsconfig.base.json')) as {
    compilerOptions: Record<string, unknown>;
    include: string[];
  };
  const emit = (await readJsonc('../tsconfig.emit.json')) as {
    compilerOptions: Record<string, unknown>;
    extends: string;
  };

  // `${configDir}` is what lets a base config in node_modules express
  // project-relative paths, and so ship the boilerplate at all.
  expect(base.compilerOptions.rootDirs).toEqual([
    '${configDir}',
    '${configDir}/.shinro/types',
  ]);
  expect(base.include).toContain('${configDir}/.shinro/**/*.ts');
  expect(base.compilerOptions.allowImportingTsExtensions).toBe(true);
  expect(base.compilerOptions.noEmit).toBe(true);

  expect(emit.extends).toBe('./tsconfig.base.json');
  expect(emit.compilerOptions.noEmit).toBe(false);
  expect(emit.compilerOptions.rewriteRelativeImportExtensions).toBe(true);
});

test('the package build does not leak the fixture application environment', async () => {
  const packageRoot = new URL('..', import.meta.url);
  // Not `dist`: the example app tests the published build, and a pack that
  // cleans `dist` out from under it is a race.
  const outputDirectory = 'dist-declarations';

  await run(
    new URL('../node_modules/.bin/vp', import.meta.url).pathname,
    // `--no-exports` because packing would otherwise rewrite the real `bin` and
    // `exports` to point at the directory this build is about to delete.
    ['pack', '--out-dir', outputDirectory, '--no-exports'],
    { cwd: packageRoot.pathname }
  );

  const declaration = await readFile(
    new URL(`../${outputDirectory}/app.d.mts`, import.meta.url),
    'utf8'
  );
  await rm(new URL(`../${outputDirectory}`, import.meta.url), {
    force: true,
    recursive: true,
  });
  // Doc comments are stripped first: they legitimately show an example env, and
  // the leak this guards against would be in the declarations themselves.
  const declared = declaration.replace(/\/\*[\s\S]*?\*\//g, '');

  expect(declared).not.toContain('tests/fixtures');
  expect(declared).not.toContain('requestId');
  // Both positions resolve their environment through `RouteEnv`, rather than
  // baking in whichever application ran the build.
  expect(declared).toContain('Handler<RouteEnv<Route>');
  expect(declared).toContain('E extends Env = RouteEnv<Route>');
  // `ShinroEnv` ships empty, for the project to augment.
  expect(declared).toMatch(/interface ShinroEnv extends Env \{\s*\}/);
});

async function readJsonc(path: string): Promise<unknown> {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  return JSON.parse(source.replace(/^\s*\/\/.*$/gm, '')) as unknown;
}
