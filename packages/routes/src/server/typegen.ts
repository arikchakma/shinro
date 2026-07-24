import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import {
  ENTRY_FILE,
  GENERATED_NOTICE,
  LEGACY_GENERATED_ENTRIES,
} from '../constants.ts';
import type { GeneratedSources } from './codegen.ts';

let temporaryFileCounter = 0;

const RPC_FILES = ['rpc.ts', 'client.ts', 'modules.d.ts'];

export async function writeGeneratedTypes(
  outputDirectory: string,
  sources: GeneratedSources,
  options: { rpcEnabled: boolean }
): Promise<void> {
  await mkdir(resolve(outputDirectory, 'types'), { recursive: true });

  await withGenerationLock(outputDirectory, async () => {
    await writeGeneratedFiles(outputDirectory, sources, options);
  });
}

// Every file is written in place through its own atomic tmp+rename, and files
// whose contents already match are left untouched. Swapping the whole directory
// would make the generated tree briefly disappear, which editors observe as the
// project's types vanishing on each save.
async function writeGeneratedFiles(
  outputDirectory: string,
  sources: GeneratedSources,
  options: { rpcEnabled: boolean }
): Promise<void> {
  const companions = sources.companions.map((companion) => ({
    file: assertWithinOutput(outputDirectory, companion.file),
    source: companion.source,
  }));
  // `manifest.json` is written last so it doubles as the commit marker: once a
  // watcher observes a new manifest, every other generated file it describes is
  // already on disk. Writing it first would let readers see a manifest that
  // advertises routes the entry does not register yet.
  const files = new Map<string, string>([
    [resolve(outputDirectory, 'daroyan.d.ts'), sources.project],
    [resolve(outputDirectory, ENTRY_FILE), sources.entry],
    [resolve(outputDirectory, 'types/app.d.ts'), sources.app],
    ...companions.map(
      (companion) => [companion.file, companion.source] as const
    ),
    ...(options.rpcEnabled
      ? ([
          [resolve(outputDirectory, 'rpc.ts'), sources.rpc],
          [resolve(outputDirectory, 'client.ts'), sources.client],
          [resolve(outputDirectory, 'modules.d.ts'), sources.entryTypes],
        ] as const)
      : []),
    [resolve(outputDirectory, 'manifest.json'), sources.manifest],
  ]);

  await assertFileTargets([...files.keys()]);
  await removeStaleCompanions(
    resolve(outputDirectory, 'types'),
    new Set(companions.map((companion) => companion.file))
  );

  // Output written by an earlier Daroyan version is cleaned up on the first
  // generation after an upgrade.
  await Promise.all(
    LEGACY_GENERATED_ENTRIES.map((name) =>
      removeGeneratedFile(resolve(outputDirectory, name))
    )
  );

  if (!options.rpcEnabled) {
    await Promise.all(
      RPC_FILES.map((name) =>
        removeGeneratedFile(resolve(outputDirectory, name))
      )
    );
  }

  for (const [file, source] of files) {
    await writeGeneratedFile(file, source);
  }
}

const GENERATION_LOCK_RETRY_MS = 20;
const GENERATION_LOCK_TIMEOUT_MS = 30_000;

async function withGenerationLock<T>(
  outputDirectory: string,
  action: () => Promise<T>
): Promise<T> {
  // Kept inside the generated directory so a single `.daroyan/` ignore rule
  // covers it, and so watchers that already skip generated output are not woken
  // by Daroyan taking its own lock.
  const lockFile = resolve(outputDirectory, '.lock');
  const startedAt = Date.now();

  while (true) {
    let lock;

    try {
      lock = await open(lockFile, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }

      // A process killed mid-generation leaves its lock behind. Without this,
      // every later run would wait out the full timeout and then fail, so the
      // recorded owner is checked and an abandoned lock is reclaimed.
      if (await removeStaleLock(lockFile)) {
        continue;
      }

      if (Date.now() - startedAt >= GENERATION_LOCK_TIMEOUT_MS) {
        throw new Error(
          `[daroyan] Timed out waiting for another process to finish generating ${outputDirectory}. If no typegen process is running, remove ${lockFile} and try again.`
        );
      }

      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, GENERATION_LOCK_RETRY_MS)
      );
      continue;
    }

    try {
      await lock.writeFile(`${process.pid}\n`);
      return await action();
    } finally {
      await lock.close();
      await rm(lockFile, { force: true });
    }
  }
}

// Returns true when the lock belonged to a process that no longer exists and
// was removed, so the caller can retry immediately.
async function removeStaleLock(lockFile: string): Promise<boolean> {
  let owner: number;

  try {
    owner = Number.parseInt(await readFile(lockFile, 'utf8'), 10);
  } catch (error) {
    // The holder released it in the meantime; retrying is enough.
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }

  if (!Number.isInteger(owner) || owner <= 0) {
    return false;
  }

  try {
    // Signal 0 performs the permission and existence check without delivering
    // anything, so a live owner keeps its lock.
    process.kill(owner, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      return false;
    }
  }

  await rm(lockFile, { force: true });
  return true;
}

async function assertFileTargets(files: string[]): Promise<void> {
  for (const file of files) {
    try {
      if ((await lstat(file)).isDirectory()) {
        throw new Error(
          `[daroyan] Cannot generate ${file}: a directory exists where a generated file is required.`
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

function assertWithinOutput(outputDirectory: string, file: string): string {
  const path = relative(outputDirectory, file);
  if (path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error(
      `[daroyan] Refusing to generate a file outside ${outputDirectory}: ${file}`
    );
  }

  return resolve(outputDirectory, path);
}

async function removeStaleCompanions(
  typesDirectory: string,
  currentCompanions: Set<string>
): Promise<void> {
  const entries = await readdir(typesDirectory, {
    recursive: true,
    withFileTypes: true,
  });

  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || !entry.name.endsWith('.d.ts')) {
        return;
      }

      const file = resolve(entry.parentPath, entry.name);
      if (!file.split(sep).includes('+types') || currentCompanions.has(file)) {
        return;
      }

      if ((await readFile(file, 'utf8')).startsWith(GENERATED_NOTICE)) {
        await rm(file);
      }
    })
  );
}

async function writeGeneratedFile(file: string, source: string): Promise<void> {
  try {
    if ((await readFile(file, 'utf8')) === source) {
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  await mkdir(dirname(file), { recursive: true });
  temporaryFileCounter += 1;
  const temporaryFile = `${file}.${process.pid}.${temporaryFileCounter}.tmp`;
  await writeFile(temporaryFile, source);
  await rename(temporaryFile, file);
}

async function removeGeneratedFile(file: string): Promise<void> {
  try {
    if ((await readFile(file, 'utf8')).startsWith(GENERATED_NOTICE)) {
      await rm(file);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}
