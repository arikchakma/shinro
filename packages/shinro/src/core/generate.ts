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

/** One entry of `.shinro/manifest.json`, which is the record of what was written. */
export type ManifestRoute = {
  file: string;
  kind: 'methods' | 'sub-router';
  methods?: string[];
  middleware: string[];
  mountPath?: string;
  path?: string;
};

export type Manifest = {
  format?: number;
  routes?: ManifestRoute[];
};

export type GenerateResult = {
  /** The format of the artifacts on disk, when it differs from this version's,
   * so `--check` can report an upgrade rather than a byte diff. */
  onDiskFormat?: number;
  outputDirectory: string;
  /** Generated files that no longer belong to the route tree. */
  removed: string[];
  /** Files whose contents actually changed. Empty means no watcher will fire. */
  written: string[];
};

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

  const onDisk = check
    ? (await readManifest(config.outputDirectory))?.format
    : undefined;

  return {
    ...result,
    ...(typeof onDisk === 'number' && onDisk !== GENERATED_FORMAT
      ? { onDiskFormat: onDisk }
      : {}),
    outputDirectory: config.outputDirectory,
  };
}

export async function readManifest(
  outputDirectory: string
): Promise<Manifest | undefined> {
  try {
    return JSON.parse(
      await readFile(resolve(outputDirectory, MANIFEST_FILE), 'utf8')
    ) as Manifest;
  } catch {
    return undefined;
  }
}
