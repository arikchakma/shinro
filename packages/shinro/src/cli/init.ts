import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { findProjectRoot } from '../config.ts';
import {
  CLIENT_FILE,
  CLIENT_SPECIFIER,
  OUTPUT_DIRECTORY,
  ROUTES_FILE,
  ROUTES_SPECIFIER,
} from '../constants.ts';
import { createLogger } from '../core/logger.ts';

/**
 * `shinro init [--dry-run]`
 *
 * The whole of onboarding, which is why it is a command rather than a
 * parenthetical in the docs. It writes the `imports` block, the tsconfig
 * `extends`, and the three scripts — the boilerplate the redesign adds in
 * exchange for deleting the plugin, the child process, and the ambient module
 * declarations.
 *
 * Idempotent, and it says what it changed. It merges into an existing `imports`
 * block rather than refusing, and it never overwrites a script the project
 * already defines: a project that runs `bun --watch` has made a decision, and
 * `init` is not the place to overrule it.
 */
export async function init(argv: string[]): Promise<number> {
  const logger = createLogger();
  const dryRun = argv.includes('--dry-run');
  const root = await findProjectRoot();
  const changes: string[] = [];

  try {
    changes.push(...(await updatePackageJson(root, dryRun)));
    changes.push(...(await updateTsconfig(root, dryRun, logger)));
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (changes.length === 0) {
    logger.info('[shinro] already initialised, nothing to change');
    return 0;
  }

  logger.info(
    [
      dryRun
        ? '[shinro] init would make these changes:'
        : '[shinro] init made these changes:',
      ...changes.map((change) => `  ${change}`),
    ].join('\n')
  );
  return 0;
}

async function updatePackageJson(
  root: string,
  dryRun: boolean
): Promise<string[]> {
  const file = resolve(root, 'package.json');
  let source: string;

  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    throw new Error(
      `[shinro] No package.json at ${root}. Run "shinro init" from your application's directory.`
    );
  }

  const packageJson = JSON.parse(source) as {
    imports?: Record<string, unknown>;
    scripts?: Record<string, unknown>;
  };
  const changes: string[] = [];
  const name = relative(root, file);

  const imports = { ...packageJson.imports };
  for (const [specifier, target] of [
    [ROUTES_SPECIFIER, `./${OUTPUT_DIRECTORY}/${ROUTES_FILE}`],
    [CLIENT_SPECIFIER, `./${OUTPUT_DIRECTORY}/${CLIENT_FILE}`],
  ] as const) {
    if (imports[specifier] === target) {
      continue;
    }
    changes.push(
      imports[specifier] === undefined
        ? `${name}: add imports[${JSON.stringify(specifier)}] = ${JSON.stringify(target)}`
        : `${name}: repoint imports[${JSON.stringify(specifier)}] from ${JSON.stringify(
            imports[specifier]
          )} to ${JSON.stringify(target)}`
    );
    imports[specifier] = target;
  }

  const scripts = { ...packageJson.scripts };
  for (const [script, command] of Object.entries(SCRIPTS)) {
    if (scripts[script] !== undefined) {
      continue;
    }
    changes.push(`${name}: add scripts.${script} = ${JSON.stringify(command)}`);
    scripts[script] = command;
  }

  if (changes.length > 0 && !dryRun) {
    await writeFile(
      file,
      `${JSON.stringify(
        { ...packageJson, imports, scripts },
        undefined,
        detectIndent(source)
      )}\n`
    );
  }

  return changes;
}

const SCRIPTS = {
  check: 'shinro generate --check && tsc --noEmit',
  dev: 'node --watch --import shinro/watch src/server.ts',
  prepare: 'shinro generate',
};

/**
 * tsconfig.json is JSONC, and rewriting it would mean either parsing comments or
 * losing them. So a missing file is written and an existing one is only reported
 * on — the user is one line away, and it is their line to add.
 */
async function updateTsconfig(
  root: string,
  dryRun: boolean,
  logger: { warn: (message: string) => void }
): Promise<string[]> {
  const file = resolve(root, 'tsconfig.json');
  const name = relative(root, file);
  let source: string;

  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    if (!dryRun) {
      await writeFile(file, `{\n  "extends": "shinro/tsconfig"\n}\n`);
    }
    return [`${name}: create with { "extends": "shinro/tsconfig" }`];
  }

  if (
    /"extends"\s*:\s*(?:"shinro\/tsconfig|\[[^\]]*"shinro\/tsconfig)/.test(
      source
    )
  ) {
    return [];
  }

  logger.warn(
    `[shinro] ${name} exists and does not extend "shinro/tsconfig". Add { "extends": "shinro/tsconfig" } yourself — it carries rootDirs and include, which the generated "+types" declarations need to resolve.`
  );
  return [];
}

function detectIndent(source: string): number | string {
  const match = /\n([ \t]+)"/.exec(source);
  if (!match) {
    return 2;
  }
  return match[1].startsWith('\t') ? '\t' : match[1].length;
}
