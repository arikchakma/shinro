import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite-plus';

import { daroyan } from './packages/routes/src/index.ts';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [
    daroyan({
      app: fileURLToPath(
        new URL(
          './packages/routes/tests/fixtures/basic/src/app.ts',
          import.meta.url
        )
      ),
      entry: fileURLToPath(
        new URL(
          './packages/routes/tests/fixtures/basic/src/server.ts',
          import.meta.url
        )
      ),
      routes: fileURLToPath(
        new URL(
          './packages/routes/tests/fixtures/basic/src/routes',
          import.meta.url
        )
      ),
    }),
  ],
  resolve: {
    alias: {
      'daroyan/app': fileURLToPath(
        new URL('./packages/routes/src/app.ts', import.meta.url)
      ),
    },
  },
  staged: {
    '*': 'vp check --fix',
  },
  test: {
    include: ['packages/**/*.test.ts'],
  },
  lint: {
    plugins: ['typescript', 'import'],
    rules: {
      'typescript/consistent-type-imports': 'error',
      'import/consistent-type-specifier-style': ['error', 'prefer-top-level'],
      curly: ['error', 'all'],
    },
    options: {
      typeCheck: true,
      typeAware: true,
    },
  },
  fmt: {
    endOfLine: 'lf',
    singleQuote: true,
    tabWidth: 2,
    trailingComma: 'es5',
    printWidth: 80,
    experimentalSortPackageJson: {
      sortScripts: true,
    },
    sortImports: {},
    ignorePatterns: ['dist/', 'node_modules/'],
  },
});
