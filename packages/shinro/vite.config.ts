import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite-plus';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));

// No `shinro()` plugin here: generating the test fixture's routes is a package
// script (`vp run generate`, via `pretest`), not a side effect of resolving a Vite
// config. What is left is the toolchain this package needs to test and pack itself.
export default defineConfig({
  root: packageRoot,
  resolve: {
    alias: {
      // The fixtures import `shinro/app` the way a consumer would, so the
      // package's own source has to stand in for the published entry point.
      'shinro/app': fileURLToPath(new URL('./src/app.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
  pack: {
    entry: [
      'src/index.ts',
      'src/app.ts',
      'src/cli.ts',
      'src/generate.ts',
      'src/watch.ts',
      'src/adapters/tsdown.ts',
      'src/adapters/vite.ts',
    ],
    dts: {
      tsgo: true,
    },
    exports: {
      customExports() {
        // Returned wholesale rather than spread over the generated map: the auto
        // map derives an export per entry file, which would publish
        // `./adapters/vite` beside `./vite` — two spellings of one thing.
        return {
          '.': {
            types: './dist/index.d.mts',
            import: './dist/index.mjs',
          },
          './app': {
            types: './dist/app.d.mts',
            import: './dist/app.mjs',
          },
          './cli': {
            types: './dist/cli.d.mts',
            import: './dist/cli.mjs',
          },
          // The two side-effecting preloads. Subpaths rather than flags because
          // `node --import` takes a module specifier, and that is the whole dev
          // story: no `shinro dev`, no supervisor.
          './generate': {
            types: './dist/generate.d.mts',
            import: './dist/generate.mjs',
          },
          './watch': {
            types: './dist/watch.d.mts',
            import: './dist/watch.mjs',
          },
          './tsdown': {
            types: './dist/adapters/tsdown.d.mts',
            import: './dist/adapters/tsdown.mjs',
          },
          './vite': {
            types: './dist/adapters/vite.d.mts',
            import: './dist/adapters/vite.mjs',
          },
          './tsconfig': './tsconfig.base.json',
          './tsconfig/emit': './tsconfig.emit.json',
          './package.json': './package.json',
        };
      },
    },
  },
});
