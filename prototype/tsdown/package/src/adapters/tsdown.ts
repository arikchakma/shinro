/**
 * Regenerates `.shinro` in `buildStart`, before rolldown resolves the graph.
 * That is the entire adapter — the app owns entry, format, outDir, unbundle,
 * and externals through its own tsdown config.
 *
 * Deliberately NOT a dev story: `tsdown --watch` only rebuilds on changes to
 * files already in the module graph, and a brand-new route file is not in the
 * graph until codegen puts it there. Use `shinro typegen --watch` for dev.
 */
export declare function shinro(config?: { cwd?: string }): {
  name: 'shinro';
  buildStart: () => Promise<void>;
};
