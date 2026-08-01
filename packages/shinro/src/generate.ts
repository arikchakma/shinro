import { runPreload } from './preload.ts';

/**
 * Generates once, for a runner that already watches a directory:
 *
 *   node --watch --watch-path=src --import shinro/generate src/server.ts
 *
 * It has to be `--import` rather than an import inside a dev entry: ESM resolves
 * a whole graph before evaluating any of it, so `#shinro/routes` would resolve
 * before generation ran.
 */
await runPreload({ watch: false });
