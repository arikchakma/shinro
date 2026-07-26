import type { ResolvedShinroConfig } from '../config.ts';
import type { ShinroLogger } from './logger.ts';

export type GenerateResult = {
  outputDirectory: string;
  /** Files whose contents actually changed. Empty means no watcher will fire. */
  written: string[];
};

/**
 * The single entry point for everything Shinro does: scan, validate, emit.
 *
 * Was `generateSources(resolvedConfig, options, outDir)` in server/codegen.ts —
 * the only things it ever read off Vite's ResolvedConfig were `root` and
 * `logger`, so it now takes them directly.
 */
export declare function generate(options: {
  config: ResolvedShinroConfig;
  logger: ShinroLogger;
}): Promise<GenerateResult>;
