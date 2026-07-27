import type { ShinroConfig } from '../config.ts';

/**
 * Calls `generate` in `buildStart`, before rolldown resolves the graph. That is
 * the entire adapter — the app owns entry, format, outDir, unbundle, and
 * externals through its own tsdown config.
 *
 * Deliberately NOT a dev story: `tsdown --watch` only rebuilds on changes to
 * files already in the module graph, and a brand-new route file is not in the
 * graph until codegen puts it there. Dev is `node --watch` plus the
 * `shinro/generate` preload.
 *
 * Never load-bearing. An app that deletes this plugin and runs `shinro generate`
 * in a package script gets byte-identical output — the plugin only removes a
 * manual step. If that stops being true, a capability leaked out of the core.
 *
 * `config` is passed to `loadConfig` as overrides, so config-in-code works here
 * for anyone who would rather not keep a `shinro.config.json`.
 */
export declare function shinro(config?: ShinroConfig & { cwd?: string }): {
  name: 'shinro';
  buildStart: () => Promise<void>;
};
