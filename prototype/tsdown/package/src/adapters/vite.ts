import type { ShinroConfig } from '../config.ts';

/**
 * The same ~20 lines for anyone already on Vite/vp. Calls `generate` in
 * `configResolved` and `watch` for route-tree changes. `vp dev` projects keep
 * working; Vite is demoted from the integration to one adapter among several.
 *
 * Gone from the old plugin: `config()` build coercion (rolldownOptions,
 * preserveModules, ssr.external), `generateBundle` single-artifact assertions,
 * `resolveId` for `shinro/routes` · `shinro/client` · `shinro/rpc` (package.json
 * `imports` handles resolution now, in every runner rather than only this one),
 * DevelopmentProcess, SHINRO_DEV_CHILD, and the double watcher.
 *
 * It may still alias `shinro/routes` to the generated file as a back-compat
 * shim, so projects that already wrote the bare specifier keep resolving while
 * `#shinro/routes` is the documented form.
 *
 * Never load-bearing, same as the tsdown adapter.
 */
export declare function shinro(config?: ShinroConfig & { cwd?: string }): {
  name: 'shinro';
  enforce: 'pre';
};
