import { access } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { findProjectRoot, loadConfig } from './config.ts';
import { OUTPUT_DIRECTORY, ROUTES_FILE } from './constants.ts';
import { generate } from './core/generate.ts';
import type { GenerateResult } from './core/generate.ts';
import { createLogger } from './core/logger.ts';
import { watch } from './core/watch.ts';

export async function runPreload(options: { watch: boolean }): Promise<void> {
  const logger = createLogger();
  const root = await findProjectRoot();

  try {
    const config = await loadConfig(root, logger);
    const report = (result: GenerateResult): void => {
      const changed = [...result.written, ...result.removed].map((file) =>
        relative(root, file)
      );
      if (changed.length > 0) {
        logger.info(`[shinro] generated ${changed.length} file(s)`);
      }
    };

    if (options.watch) {
      await watch({ config, logger, onGenerate: report });
      return;
    }

    report(await generate({ config, logger }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (await hasPreviousGeneration(root)) {
      logger.error(message);
      return;
    }

    throw new Error(
      `${message}\n[shinro] Nothing has been generated yet, so the server cannot start. Fix the above and rerun, or run "shinro generate" to see it on its own.`,
      { cause: error }
    );
  }
}

async function hasPreviousGeneration(root: string): Promise<boolean> {
  try {
    await access(resolve(root, OUTPUT_DIRECTORY, ROUTES_FILE));
    return true;
  } catch {
    return false;
  }
}
