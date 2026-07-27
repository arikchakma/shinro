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
 * filesystem and an unconditional write is a server restart.
 *
 * The whole generation is assembled in a staging directory first, then promoted
 * file by file with `rename`:
 *
 *   - compare against disk and skip identical content, leaving mtime untouched;
 *   - stage the files that changed, so nothing lands until all of them exist;
 *   - promote by rename, which is atomic, so no runner ever imports a half-file;
 *   - on failure, the previous generation is still in place, byte for byte.
 *
 * Skipping identical content is not an optimisation, it is load-bearing. With
 * `shinro/generate` as a `--import` preload, generation runs on every restart,
 * so an unconditional write bumps the mtime of a file the runner is watching,
 * which triggers a restart, which regenerates, which writes again — a loop that
 * only compare-then-skip settles.
 *
 * `dry` performs the comparison and reports what would change without touching
 * anything, which is all `generate --check` is. One code path decides both what
 * to write and whether the tree is stale, so the two can't disagree.
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

  const stale = await staleFiles(
    outputDirectory,
    new Set(targets.map(([file]) => file))
  );

  if (options.dry) {
    return {
      removed: stale,
      written: changed.map(([file]) => file),
    };
  }

  // Nothing to do, and nothing done: no directory is created, no mtime moves,
  // and a watcher stays asleep. This is the steady state of the dev loop, so it
  // has to be free of side effects rather than merely cheap.
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

/**
 * Staging lives inside `.shinro` so that `rename` stays within one filesystem —
 * across a mount point it is a copy, and a copy is not atomic. It also means a
 * single `.shinro/` ignore rule already covers the temporary files, and a runner
 * that watches the module graph never sees them at all.
 *
 * There is no lock file. Two processes generating at once — a `tsdown` build
 * beside a dev server — each stage their own tree and promote by rename, and
 * because codegen is deterministic they are promoting identical bytes.
 */
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

  try {
    for (const [file, source] of changed) {
      const staged = resolve(staging, relative(outputDirectory, file));
      await mkdir(dirname(staged), { recursive: true });
      await writeFile(staged, source);
    }

    // Promotion order follows the map, and codegen puts `manifest.json` last, so
    // a reader that trusts the manifest is trusting a description of files that
    // are already in place.
    for (const [file] of changed) {
      const staged = resolve(staging, relative(outputDirectory, file));
      await mkdir(dirname(file), { recursive: true });
      await rename(staged, file);
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

/**
 * Generated files that the current route tree no longer accounts for: the
 * `+types` declaration of a deleted route, and the artifacts of an older format.
 * Both are worse than absent — a stale declaration keeps type-checking against a
 * route that is gone.
 *
 * Only files carrying the generated notice are ever removed. Anything else in
 * `.shinro` belongs to whoever put it there.
 */
async function staleFiles(
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
    try {
      if ((await lstat(file)).isDirectory()) {
        throw new Error(
          `[shinro] Cannot generate ${file}: a directory exists where a generated file is required.`
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
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
