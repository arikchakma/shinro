import { resolve } from 'node:path';

import { findProjectRoot, loadConfig } from '../config.ts';
import type { ShinroConfig } from '../config.ts';
import { CLIENT_FILE, ROUTES_FILE } from '../constants.ts';
import { generate } from '../core/generate.ts';
import { fromHost } from '../core/logger.ts';
import type { ShinroLogger } from '../core/logger.ts';
import { watch } from '../core/watch.ts';

/**
 * Vite's `ResolvedConfig`, reduced to what this adapter reads. Typed
 * structurally on purpose: `vite` is an optional peer, so importing its types
 * here would make the whole package fail to type-check in a project that never
 * installed it.
 */
type ResolvedViteConfig = {
  command: 'build' | 'serve';
  logger?: Partial<ShinroLogger>;
  root: string;
};

/**
 * Generation for anyone already on Vite/vp: `configResolved` generates, and dev
 * watches the route tree.
 *
 * Never load-bearing. An app that deletes this plugin and runs `shinro generate`
 * in a script gets byte-identical output.
 */
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
      const logger = fromHost(resolved.logger ?? {});
      const root = await findProjectRoot(cwd ?? resolved.root);
      const shinroConfig = await loadConfig(root, logger, overrides);
      outputDirectory = shinroConfig.outputDirectory;

      if (resolved.command === 'build') {
        await generate({ config: shinroConfig, logger });
        return;
      }

      // In dev the watcher generates once before it starts watching, so this
      // covers both halves. Vite's own watcher is not involved: it watches the
      // module graph, and a brand-new route file is not in it.
      watcher = await watch({
        config: shinroConfig,
        initial: 'report',
        logger,
      });
    },
    /**
     * The bare specifiers, kept working. `#shinro/routes` is the documented form
     * because it resolves in every runner; these aliases point at the same files
     * and only this adapter offers them, so a project relying on them is relying
     * on Vite.
     */
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
