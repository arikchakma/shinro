import { runPreload } from './preload.ts';

/**
 * The documented dev loop, and the whole of it:
 *
 *   node --watch --watch-preserve-output --import shinro/watch src/server.ts
 *
 * A new route file is invisible to `--watch`, which watches the module graph.
 * This watcher sees it and writes `routes.ts`, which *is* in the graph, so the
 * restart follows and re-runs this preload.
 */
await runPreload({ watch: true });
