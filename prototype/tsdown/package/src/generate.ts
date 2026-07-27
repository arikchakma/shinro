/**
 * `shinro/generate` — a side-effecting module for `node --import`.
 *
 *   node --watch --watch-path=src --import shinro/generate src/server.ts
 *
 * This is what makes single-process development possible, and it is the reason
 * there is no `shinro dev`. Node owns the process: it watches, it restarts, it
 * signals. Shinro only guarantees that by the time the entry's module graph is
 * loaded, `.shinro` matches the route tree on disk.
 *
 * Why it works, in order:
 *
 *   1. `--import` modules are fully evaluated — top-level `await` included —
 *      before the entry is loaded, so generation finishes before anything
 *      resolves `#shinro/routes`.
 *   2. `--watch-path=src` watches the directory, not the module graph, so a
 *      brand-new route file triggers a restart even though nothing imports it
 *      yet. (A graph watcher cannot see a file no module references — that is
 *      the gap `tsdown --watch` and bare `node --watch` both have.)
 *   3. The restart re-runs this module, which regenerates, so the new route is
 *      registered.
 *
 * REQUIRES content-aware writes. `core/emit.ts` skips identical content and
 * leaves mtime alone; without that, step 3 rewrites a file inside the watched
 * tree, which triggers step 2, which triggers step 3 — an infinite restart
 * loop. Verified both ways: unconditional writes loop forever, hash-then-skip
 * is stable at exactly one restart per real change.
 *
 * It must be `--import`, not an import inside a dev entry. ESM resolves and
 * loads an entire graph before evaluating any of it, so a `src/dev.ts` that did
 * `import 'shinro/generate'; import './server.ts';` would have `#shinro/routes`
 * resolved before generation ran — fine once `.shinro` exists, broken on a cold
 * clone, which is the worst shape a bug can take. `--import` modules are a
 * separate graph, evaluated to completion before the entry is resolved. That is
 * the same guarantee loader hooks rely on.
 *
 * With a runner that only watches the module graph, pass this through
 * `NODE_OPTIONS` and add the routes directory to the runner's watch list:
 *
 *   NODE_OPTIONS="--import shinro/generate" tsx watch --include "src/routes/**" src/server.ts
 *
 * Diagnostics print and the process continues on a route conflict, because the
 * previous generation is still on disk and crash-looping the runner over a typo
 * is worse than serving a stale route for two seconds.
 */
export {};
