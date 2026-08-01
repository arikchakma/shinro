import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import {
  GENERATED_NOTICE_PATTERN,
  LEGACY_FILES,
  STAGING_DIRECTORY,
  TYPE_DECLARATION_PREFIX,
} from '../constants.ts';
import type { GeneratedFiles } from './codegen.ts';

export type EmitResult = {
  /** Files that no longer belong to the current route tree. */
  removed: string[];
  /** Files whose contents actually changed. Empty means no watcher will fire. */
  written: string[];
};

let stagingCounter = 0;

/**
 * Every write goes through here, because the user's runner is watching the
 * filesystem and an unconditional write is a server restart:
 *
 *   - compare against disk and skip identical content, leaving mtime untouched;
 *   - stage the files that changed, so nothing lands until all of them exist;
 *   - promote by rename, which is atomic, so no runner imports a half-file;
 *   - on failure, the previous generation is still in place, byte for byte.
 *
 * Skipping is load-bearing, not an optimisation: generation runs on every
 * restart, so an unconditional write would restart the runner, which regenerates.
 */
export async function emit(
  outputDirectory: string,
  files: GeneratedFiles,
  options: { dry?: boolean } = {}
): Promise<EmitResult> {
  const targets = [...files].map(
    ([file, source]) =>
      [resolveWithinOutput(outputDirectory, file), source] as const
  );

  await assertNotDirectories(targets.map(([file]) => file));

  const changed: Array<readonly [string, string]> = [];
  for (const [file, source] of targets) {
    if (!(await isUpToDate(file, source))) {
      changed.push([file, source]);
    }
  }

  const stale = await findStaleFiles(
    outputDirectory,
    new Set(targets.map(([file]) => file))
  );

  if (options.dry) {
    return {
      removed: stale,
      written: changed.map(([file]) => file),
    };
  }

  if (changed.length === 0 && stale.length === 0) {
    return { removed: [], written: [] };
  }

  if (changed.length > 0) {
    await promote(outputDirectory, changed);
  }

  for (const file of stale) {
    await rm(file, { force: true });
  }

  return { removed: stale, written: changed.map(([file]) => file) };
}

/** Staging lives inside `.shinro` so `rename` stays within one filesystem: across
 * a mount point it is a copy, and a copy is not atomic. */
async function promote(
  outputDirectory: string,
  changed: Array<readonly [string, string]>
): Promise<void> {
  stagingCounter += 1;
  const staging = resolve(
    outputDirectory,
    STAGING_DIRECTORY,
    `${process.pid}-${stagingCounter}`
  );

  const staged = changed.map(
    ([file, source]) =>
      [resolve(staging, relative(outputDirectory, file)), file, source] as const
  );

  try {
    for (const [stagedFile, , source] of staged) {
      await mkdir(dirname(stagedFile), { recursive: true });
      await writeFile(stagedFile, source);
    }

    for (const [stagedFile, file] of staged) {
      await mkdir(dirname(file), { recursive: true });
      await rename(stagedFile, file);
    }
  } finally {
    await rm(staging, { force: true, recursive: true });
    // Fails while another process still has a staging directory of its own,
    // which is exactly when it should be left alone.
    await rmdir(resolve(outputDirectory, STAGING_DIRECTORY)).catch(() => {});
  }
}

async function isUpToDate(file: string, source: string): Promise<boolean> {
  try {
    return (await readFile(file, 'utf8')) === source;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    return false;
  }
}

async function findStaleFiles(
  outputDirectory: string,
  current: Set<string>
): Promise<string[]> {
  const stale: string[] = [];

  for (const name of LEGACY_FILES) {
    const file = resolve(outputDirectory, name);
    if (!current.has(file) && (await isGeneratedFile(file))) {
      stale.push(file);
    }
  }

  let entries;
  try {
    entries = await readdir(resolve(outputDirectory, 'types'), {
      recursive: true,
      withFileTypes: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    return stale.sort();
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.d.ts')) {
      continue;
    }

    const file = resolve(entry.parentPath, entry.name);
    if (
      file.split(sep).includes(TYPE_DECLARATION_PREFIX) &&
      !current.has(file) &&
      (await isGeneratedFile(file))
    ) {
      stale.push(file);
    }
  }

  return stale.sort();
}

async function isGeneratedFile(file: string): Promise<boolean> {
  try {
    return GENERATED_NOTICE_PATTERN.test(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    return false;
  }
}

async function assertNotDirectories(files: string[]): Promise<void> {
  for (const file of files) {
    const stats = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      return undefined;
    });

    if (stats?.isDirectory()) {
      throw new Error(
        `[shinro] Cannot generate ${file}: a directory exists where a generated file is required.`
      );
    }
  }
}

function resolveWithinOutput(outputDirectory: string, file: string): string {
  const path = relative(outputDirectory, file);
  if (path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error(
      `[shinro] Refusing to generate a file outside ${outputDirectory}: ${file}`
    );
  }

  return resolve(outputDirectory, path);
}
