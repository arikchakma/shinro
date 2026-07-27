import type { ResolvedShinroConfig } from '../config.ts';
import type { GenerateResult } from './generate.ts';
import type { ShinroLogger } from './logger.ts';

/**
 * A debounced directory watcher that calls `generate` and reports what changed.
 *
 * It watches the routes directory rather than a module graph, because that is
 * the one thing a graph watcher structurally cannot do: nothing imports a
 * brand-new route file, so nothing in the graph points at it. That gap is why
 * `tsdown --watch` and bare `node --watch` both miss new routes.
 *
 * What it does not do, and must never do: spawn a process, restart a process,
 * install a signal handler, or hold a reference to the user's server. It writes
 * files. The runner notices. That is the whole contract, and it is what keeps
 * `shinro dev` from being necessary.
 */
export declare function watch(options: {
  config: ResolvedShinroConfig;
  logger: ShinroLogger;
  onGenerate?: (result: GenerateResult) => void;
}): Promise<{ close: () => Promise<void> }>;
