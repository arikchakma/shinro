// Public programmatic surface. No Vite, no tsdown, no bundler.
//
// Anyone can write the adapter Shinro doesn't ship — unbuild, rspack, a Turbo
// task, a Makefile — against these four exports. If something is only reachable
// through `shinro/vite` or `shinro/tsdown`, it belongs here instead.
export { generate } from './core/generate.ts';
export { watch } from './core/watch.ts';
export { loadConfig } from './config.ts';
export type { ShinroConfig, ResolvedShinroConfig } from './config.ts';
export type { GenerateResult } from './core/generate.ts';
export type { ShinroLogger } from './core/logger.ts';
