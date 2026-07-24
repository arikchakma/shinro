import {
  cp,
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

import { GENERATED_NOTICE } from '../constants.ts';
import type { GeneratedSources } from './codegen.ts';

let temporaryFileCounter = 0;

export async function writeGeneratedTypes(
  outputDirectory: string,
  sources: GeneratedSources,
  options: { rpcEnabled: boolean }
): Promise<void> {
  await mkdir(dirname(outputDirectory), { recursive: true });

  await withGenerationLock(outputDirectory, async () => {
    await writeGeneratedTypesTransaction(outputDirectory, sources, options);
  });
}

async function writeGeneratedTypesTransaction(
  outputDirectory: string,
  sources: GeneratedSources,
  options: { rpcEnabled: boolean }
): Promise<void> {
  temporaryFileCounter += 1;
  const transaction = `${process.pid}.${temporaryFileCounter}`;
  const stagingDirectory = `${outputDirectory}.${transaction}.stage`;
  const backupDirectory = `${outputDirectory}.${transaction}.backup`;
  const desiredFiles = [
    resolve(outputDirectory, 'manifest.json'),
    resolve(outputDirectory, 'daroyan.d.ts'),
    resolve(outputDirectory, 'types/app.d.ts'),
    ...sources.companions.map((companion) => companion.file),
    ...(options.rpcEnabled
      ? [
          resolve(outputDirectory, 'rpc.ts'),
          resolve(outputDirectory, 'client.ts'),
          resolve(outputDirectory, 'entry.d.ts'),
        ]
      : []),
  ];

  await assertFileTargets(desiredFiles);
  await rm(stagingDirectory, { recursive: true, force: true });
  await rm(backupDirectory, { recursive: true, force: true });

  try {
    try {
      await cp(outputDirectory, stagingDirectory, {
        preserveTimestamps: true,
        recursive: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      await mkdir(stagingDirectory, { recursive: true });
    }

    await populateStagingDirectory(
      outputDirectory,
      stagingDirectory,
      sources,
      options
    );
    await commitStagingDirectory(
      outputDirectory,
      stagingDirectory,
      backupDirectory
    );
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(
      () => undefined
    );
  }
}

const GENERATION_LOCK_RETRY_MS = 20;
const GENERATION_LOCK_TIMEOUT_MS = 30_000;

async function withGenerationLock<T>(
  outputDirectory: string,
  action: () => Promise<T>
): Promise<T> {
  const lockFile = `${outputDirectory}.lock`;
  const startedAt = Date.now();

  while (true) {
    let lock;

    try {
      lock = await open(lockFile, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
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

async function populateStagingDirectory(
  outputDirectory: string,
  stagingDirectory: string,
  sources: GeneratedSources,
  options: { rpcEnabled: boolean }
): Promise<void> {
  const typesDirectory = resolve(stagingDirectory, 'types');

  await mkdir(typesDirectory, { recursive: true });
  await removeStaleCompanions(
    typesDirectory,
    new Set(
      sources.companions.map((companion) =>
        toStagingFile(outputDirectory, stagingDirectory, companion.file)
      )
    )
  );
  await writeGeneratedFile(
    resolve(stagingDirectory, 'manifest.json'),
    sources.manifest
  );
  await writeGeneratedFile(
    resolve(stagingDirectory, 'daroyan.d.ts'),
    sources.project
  );
  await writeGeneratedFile(resolve(typesDirectory, 'app.d.ts'), sources.app);
  for (const companion of sources.companions) {
    await writeGeneratedFile(
      toStagingFile(outputDirectory, stagingDirectory, companion.file),
      companion.source
    );
  }
  if (options.rpcEnabled) {
    await writeGeneratedFile(resolve(stagingDirectory, 'rpc.ts'), sources.rpc);
    await writeGeneratedFile(
      resolve(stagingDirectory, 'client.ts'),
      sources.client
    );
    await writeGeneratedFile(
      resolve(stagingDirectory, 'entry.d.ts'),
      sources.entryTypes
    );
  } else {
    await Promise.all(
      [
        resolve(stagingDirectory, 'rpc.ts'),
        resolve(stagingDirectory, 'client.ts'),
        resolve(stagingDirectory, 'entry.d.ts'),
      ].map(removeGeneratedFile)
    );
  }
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

async function commitStagingDirectory(
  outputDirectory: string,
  stagingDirectory: string,
  backupDirectory: string
): Promise<void> {
  let movedExistingOutput = false;

  try {
    await rename(outputDirectory, backupDirectory);
    movedExistingOutput = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    await rename(stagingDirectory, outputDirectory);
  } catch (error) {
    if (movedExistingOutput) {
      await rename(backupDirectory, outputDirectory);
    }
    throw error;
  }

  if (movedExistingOutput) {
    await rm(backupDirectory, { recursive: true, force: true }).catch(
      () => undefined
    );
  }
}

function toStagingFile(
  outputDirectory: string,
  stagingDirectory: string,
  file: string
): string {
  const path = relative(outputDirectory, file);
  if (path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error(
      `[daroyan] Refusing to generate a file outside ${outputDirectory}: ${file}`
    );
  }

  return resolve(stagingDirectory, path);
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
