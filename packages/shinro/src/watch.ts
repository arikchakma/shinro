import { runPreload } from './preload.ts';

/**
 * `shinro/watch` — the documented dev loop, and the whole of it:
 *
 *   node --watch --import shinro/watch src/server.ts
 *
 * Generates once before the entry resolves, then keeps one debounced watcher on
 * the routes directory for the life of the process. Plain `--watch` is graph
 * watching, which every platform supports, and the graph is enough because the
 * new-file gap funnels through a file the graph already contains:
 *
 *   1. a brand-new route file is invisible to a graph watcher — nothing imports
 *      it yet;
 *   2. this watcher sees it and regenerates, which changes `routes.ts`;
 *   3. `routes.ts` *is* in the graph via `#shinro/routes`, so `--watch` restarts;
 *   4. the restart re-runs this preload, which regenerates and re-establishes the
 *      watcher — so anything that changed during the restart gap is reconciled on
 *      boot.
 *
 * Edits to existing route files never need step 2 at all: they are in the graph
 * on their own.
 *
 * This is only a watcher. It spawns nothing, restarts nothing, and installs no
 * signal handler — Node still owns the process. Which is the reason there is no
 * `shinro dev`: anything that spawned the runner would be a supervisor, and a
 * supervisor owes you SIGTERM semantics within a release.
 */
await runPreload({ watch: true });
