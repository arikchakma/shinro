import { defineConfig } from 'vite-plus';

export default defineConfig({
  staged: {
    '*': 'vp check --fix',
  },
  test: {
    // The watcher tests wait on real fs events, and the tsc the typecheck
    // suites spawn saturates the machine long enough to miss them.
    fileParallelism: false,
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
    ignorePatterns: ['.astro/'],
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
    // `_static/` holds the readme cover source, whose code panel relies on
    // `white-space: pre` and so cannot survive reflowing. `.astro/` is the
    // docs app's generated content cache.
    ignorePatterns: ['_static/', '.astro/', 'dist/', 'node_modules/'],
  },
});
