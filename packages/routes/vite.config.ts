import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite-plus';

import { daroyan } from './src/index.ts';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const fixture = fileURLToPath(
  new URL('./tests/fixtures/basic', import.meta.url)
);

export default defineConfig({
  root: packageRoot,
  plugins: [
    daroyan({
      app: `${fixture}/src/app.ts`,
      entry: `${fixture}/src/server.ts`,
      routes: `${fixture}/src/routes`,
    }),
  ],
  resolve: {
    alias: {
      'daroyan/app': fileURLToPath(new URL('./src/app.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
  pack: {
    entry: ['src/index.ts', 'src/app.ts', 'src/cli.ts'],
    dts: {
      tsgo: true,
    },
    exports: {
      customExports(exports) {
        return {
          ...exports,
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
          './tsconfig': './tsconfig.base.json',
          './package.json': './package.json',
        };
      },
    },
  },
});
