import { findProjectRoot, loadConfig } from '../config.ts';
import type { ShinroConfig } from '../config.ts';
import { generate } from '../core/generate.ts';
import { createLogger } from '../core/logger.ts';

/** Calls `generate` in `buildStart`, before rolldown resolves the graph. Not a
 * dev story: `tsdown --watch` only sees files already in the module graph. */
export function shinro(config?: ShinroConfig & { cwd?: string }): {
  name: 'shinro';
  buildStart: () => Promise<void>;
} {
  const { cwd, ...overrides } = config ?? {};

  return {
    name: 'shinro',
    buildStart: async () => {
      const logger = createLogger();
      const root = await findProjectRoot(cwd);
      await generate({
        config: await loadConfig(root, logger, overrides),
        logger,
      });
    },
  };
}
