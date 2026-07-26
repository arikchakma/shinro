/**
 * The same ~20 lines for anyone already on Vite/vp. Generates in
 * `configResolved` and regenerates on route-tree changes.
 *
 * Gone from the old plugin: `config()` build coercion (rolldownOptions,
 * preserveModules, ssr.external), `generateBundle` single-artifact assertions,
 * `resolveId` for `shinro/routes` (package.json `imports` handles it now),
 * DevelopmentProcess, SHINRO_DEV_CHILD, and the double watcher.
 */
export declare function shinro(config?: { cwd?: string }): {
  name: 'shinro';
  enforce: 'pre';
};
