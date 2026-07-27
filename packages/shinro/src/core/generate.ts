import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ResolvedShinroConfig } from '../config.ts';
import { GENERATED_FORMAT, MANIFEST_FILE } from '../constants.ts';
import { generateSources } from './codegen.ts';
import { emit } from './emit.ts';
import type { ShinroLogger } from './logger.ts';
import {
  validatePackageImports,
  validateTypeScriptConfig,
} from './validate.ts';

export type GenerateResult = {
  /**
   * The format number of the artifacts already on disk, when it differs from
   * this version's. `--check` reads it so an upgrade reports "run shinro
   * generate" instead of a byte diff nobody can act on.
   */
  onDiskFormat?: number;
  outputDirectory: string;
  /** Generated files that no longer belong to the route tree. */
  removed: string[];
  /** Files whose contents actually changed. Empty means no watcher will fire. */
  written: string[];
};

/**
 * The single entry point for everything Shinro does: scan, validate, emit.
 *
 * Was `generateSources(resolvedConfig, options, outDir)` in server/codegen.ts —
 * the only things it ever read off Vite's ResolvedConfig were `root` and
 * `logger`, so it takes them directly.
 *
 * `check` compares the generation against disk and writes nothing. It is the
 * same code path, one flag deep, which is the only way the CI gate and the build
 * can be guaranteed to agree.
 */
export async function generate(options: {
  check?: boolean;
  config: ResolvedShinroConfig;
  logger: ShinroLogger;
}): Promise<GenerateResult> {
  const { check = false, config, logger } = options;
  const files = await generateSources({ config, logger });
  const result = await emit(config.outputDirectory, files, { dry: check });

  if (!check) {
    await Promise.all([
      validateTypeScriptConfig({ logger, root: config.root }),
      validatePackageImports({
        logger,
        outputDirectory: config.outputDirectory,
        root: config.root,
      }),
    ]);
  }

  return {
    ...result,
    ...(check ? await onDiskFormat(config.outputDirectory) : {}),
    outputDirectory: config.outputDirectory,
  };
}

async function onDiskFormat(
  outputDirectory: string
): Promise<{ onDiskFormat?: number }> {
  try {
    const manifest = JSON.parse(
      await readFile(resolve(outputDirectory, MANIFEST_FILE), 'utf8')
    ) as { format?: unknown };

    return typeof manifest.format === 'number' &&
      manifest.format !== GENERATED_FORMAT
      ? { onDiskFormat: manifest.format }
      : {};
  } catch {
    // No manifest, or one nobody can parse: the byte diff already says the tree
    // needs regenerating, and guessing at a format would only add noise.
    return {};
  }
}
