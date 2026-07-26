// Public programmatic surface. No Vite, no tsdown, no bundler.
export { generate } from './core/generate.ts';
export { loadConfig } from './config.ts';
export type { ShinroConfig } from './config.ts';
export type { ShinroLogger } from './core/logger.ts';
