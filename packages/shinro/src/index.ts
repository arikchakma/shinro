// Public programmatic surface. No Vite, no tsdown, no bundler.
//
// Anyone can write the adapter Shinro doesn't ship — unbuild, rspack, a Turbo
// task, a Makefile — against these exports. If something is only reachable
// through `shinro/vite` or `shinro/tsdown`, it belongs here instead.
export { findProjectRoot, loadConfig } from './config.ts';
export type { ResolvedShinroConfig, ShinroConfig } from './config.ts';
export { generate } from './core/generate.ts';
export type { GenerateResult } from './core/generate.ts';
export { createLogger, hostLogger } from './core/logger.ts';
export type { ShinroLogger } from './core/logger.ts';
export { watch } from './core/watch.ts';
