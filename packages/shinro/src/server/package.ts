import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import type { Logger } from 'vite-plus';

export async function warnForMissingClientExport(options: {
  logger: Logger;
  outputDirectory: string;
  root: string;
}): Promise<void> {
  const packageFile = resolve(options.root, 'package.json');
  let packageJson: { exports?: unknown };

  try {
    packageJson = JSON.parse(await readFile(packageFile, 'utf8')) as {
      exports?: unknown;
    };
  } catch (error) {
    // A missing package.json is normal. Anything else — unreadable or invalid
    // JSON — is worth saying out loud rather than silently skipping the check.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      options.logger.warn(
        `[shinro] Could not read ${packageFile}, so its generated client export was not checked: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    return;
  }

  if (
    typeof packageJson.exports !== 'object' ||
    packageJson.exports === null ||
    Array.isArray(packageJson.exports)
  ) {
    return;
  }

  const exports = packageJson.exports as Record<string, unknown>;
  const rpcTarget = generatedTarget(
    options.root,
    options.outputDirectory,
    'rpc.ts'
  );
  const clientTarget = generatedTarget(
    options.root,
    options.outputDirectory,
    'client.ts'
  );
  if (
    !pointsTo(exports['./rpc'], rpcTarget) ||
    pointsTo(exports['./client'], clientTarget)
  ) {
    return;
  }

  options.logger.warn(
    `[shinro] ${packageFile} exposes generated RPC but its generated client package export is missing. Add "./client": ${JSON.stringify(
      clientTarget
    )}.`
  );
}

function generatedTarget(
  root: string,
  outputDirectory: string,
  name: string
): string {
  const path = relative(root, resolve(outputDirectory, name))
    .split(sep)
    .join('/');
  return path.startsWith('./') || path.startsWith('../') ? path : `./${path}`;
}

function pointsTo(value: unknown, target: string): boolean {
  if (typeof value === 'string') {
    return value === target;
  }
  if (Array.isArray(value)) {
    return value.some((item) => pointsTo(item, target));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some((item) => pointsTo(item, target));
  }
  return false;
}
