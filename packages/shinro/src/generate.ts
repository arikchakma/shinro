import { runPreload } from './preload.ts';

/**
 * `shinro/generate` — a side-effecting module for `node --import`. Generates
 * once and returns.
 *
 *   node --watch --watch-path=src --import shinro/generate src/server.ts
 *
 * This is the preload for a runner that watches a *directory*: the restart
 * re-runs it, so a brand-new route file is picked up by the next boot.
 * `--watch-path` is documented for macOS and Windows only, which is why
 * `shinro/watch` — one watcher, in this process, no platform caveat — is the
 * default the docs show. Both are one line, and neither spawns anything.
 *
 * It must be `--import`, not an import inside a dev entry. ESM resolves and
 * loads an entire graph before evaluating any of it, so a `src/dev.ts` that did
 * `import 'shinro/generate'; import './server.ts';` would have `#shinro/routes`
 * resolved before generation ran — fine once `.shinro` exists, broken on a cold
 * clone. `--import` modules are a separate graph, evaluated to completion before
 * the entry is resolved.
 *
 * This is also the form that passes through `NODE_OPTIONS` for a runner with its
 * own watcher:
 *
 *   NODE_OPTIONS="--import shinro/generate" tsx watch --include "src/routes/**" src/server.ts
 */
await runPreload({ watch: false });
