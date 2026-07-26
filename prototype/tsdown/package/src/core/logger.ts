/**
 * Replaces Vite's `Logger` across the core. Three methods is the whole surface
 * the scanner, codegen, and validators ever used.
 */
export type ShinroLogger = {
  error: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
};

/** Prefixes `[shinro]` and writes to the console. Used by the CLI. */
export declare function createLogger(): ShinroLogger;

/** Wraps a host logger so adapters can forward into Vite/tsdown output. */
export declare function fromHost(host: Partial<ShinroLogger>): ShinroLogger;
