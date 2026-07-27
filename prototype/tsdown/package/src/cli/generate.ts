/**
 * `shinro generate [--watch] [--check]`
 *
 * The product. No `resolveConfig` from Vite, no plugin lookup, no dev server:
 * load config, generate, exit.
 *
 * Named for the core function it calls. The old name, `typegen`, described a
 * third of the output — `.shinro/routes.ts` is runtime code, and telling people
 * the router is a type artifact is the one belief this design can't afford.
 * `typegen` still resolves, undocumented, so existing scripts keep running.
 *
 * `--watch` debounces a watcher on the routes directory and regenerates. It
 * spawns nothing and restarts nothing; the runner is the user's business. It
 * generates once, synchronously, before it starts watching, so the artifacts
 * exist by the time anything else reads them. Only needed for runners that
 * can't watch a directory — with `node --watch --watch-path`, `shinro/generate`
 * as an `--import` preload covers dev in one process.
 *
 * `--check` generates into memory and compares against disk. Exits non-zero on
 * a route conflict, an invalid module, or a stale artifact, and writes nothing.
 * Once no bundler is guaranteed to run this is the only place a conflict can be
 * caught, so it is the CI gate — and it is what makes committing `.shinro/` a
 * supported choice rather than a trap.
 */
export declare function generate(argv: string[]): Promise<number>;
