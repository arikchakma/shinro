import { resolve } from 'node:path';

import { findProjectRoot, loadConfig } from '../config.ts';
import type { ShinroConfig } from '../config.ts';
import { CLIENT_FILE, ROUTES_FILE } from '../constants.ts';
import { generate } from '../core/generate.ts';
import { hostLogger } from '../core/logger.ts';
import type { ShinroLogger } from '../core/logger.ts';
import { watch } from '../core/watch.ts';

/** Structural on purpose: `vite` is an optional peer, so a project that never
 * installed it must still type-check. */
type ResolvedViteConfig = {
  command: 'build' | 'serve';
  logger?: Partial<ShinroLogger>;
  root: string;
};

/** Never load-bearing: deleting this plugin and running `shinro generate` in a
 * script gives byte-identical output. */
export function shinro(config?: ShinroConfig & { cwd?: string }): {
  buildEnd: () => Promise<void>;
  configResolved: (resolved: ResolvedViteConfig) => Promise<void>;
  enforce: 'pre';
  name: 'shinro';
  resolveId: (id: string) => string | undefined;
} {
  const { cwd, ...overrides } = config ?? {};
  let outputDirectory: string | undefined;
  let watcher: { close: () => Promise<void> } | undefined;

  return {
    name: 'shinro',
    enforce: 'pre',
    configResolved: async (resolved) => {
      const logger = hostLogger(resolved.logger ?? {});
      const root = await findProjectRoot(cwd ?? resolved.root);
      const shinroConfig = await loadConfig(root, logger, overrides);
      outputDirectory = shinroConfig.outputDirectory;

      if (resolved.command === 'build') {
        await generate({ config: shinroConfig, logger });
        return;
      }

      watcher = await watch({
        config: shinroConfig,
        initial: 'report',
        logger,
      });
    },
    /** The bare specifiers, which only this adapter can resolve. */
    resolveId: (id) => {
      if (!outputDirectory) {
        return undefined;
      }
      if (id === 'shinro/routes') {
        return resolve(outputDirectory, ROUTES_FILE);
      }
      if (id === 'shinro/client') {
        return resolve(outputDirectory, CLIENT_FILE);
      }
      return undefined;
    },
    buildEnd: async () => {
      await watcher?.close();
      watcher = undefined;
    },
  };
}
