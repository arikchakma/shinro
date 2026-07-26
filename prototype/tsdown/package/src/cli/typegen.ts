/**
 * `shinro typegen [--watch]`
 *
 * The product. No `resolveConfig` from Vite, no plugin lookup, no dev server:
 * load config, generate, exit. `--watch` adds a debounced watcher on the routes
 * directory and regenerates — it never spawns or restarts anything, because the
 * runner is the user's business.
 */
export declare function typegen(argv: string[]): Promise<number>;
