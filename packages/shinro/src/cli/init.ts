import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { defineCommand } from 'citty';

import { findProjectRoot } from '../config.ts';
import {
  CLIENT_FILE,
  CLIENT_SPECIFIER,
  EXTENDS_SHIPPED_TSCONFIG,
  OUTPUT_DIRECTORY,
  ROUTES_FILE,
  ROUTES_SPECIFIER,
} from '../constants.ts';
import { unknownOptions } from './args.ts';
import { createReporter } from './report.ts';

export const init = defineCommand({
  args: {
    'dry-run': {
      description: 'Report the changes without writing them',
      type: 'boolean',
    },
  },
  meta: {
    description: 'Add the imports block, tsconfig, and scripts',
    name: 'init',
  },
  async run({ args, rawArgs }) {
    const unknown = unknownOptions(rawArgs, ['--dry-run']);

    if (unknown.length > 0) {
      createReporter().error(
        `[shinro] Unknown option ${unknown.join(', ')}.\nUsage: shinro init [--dry-run]`
      );
      process.exitCode = 1;
      return;
    }

    process.exitCode = await run(args['dry-run'] === true);
  },
});

async function run(dryRun: boolean): Promise<number> {
  const logger = createReporter();
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

// `--watch-preserve-output` because Node otherwise clears the terminal on every
// restart, wiping whatever the last generation printed.
const SCRIPTS = {
  check: 'shinro generate --check && tsc --noEmit',
  dev: 'node --watch --watch-preserve-output --import shinro/watch src/server.ts',
  prepare: 'shinro generate',
};

/** tsconfig.json is JSONC, so an existing one is reported on rather than
 * rewritten: rewriting would mean parsing comments or losing them. */
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

  if (EXTENDS_SHIPPED_TSCONFIG.test(source)) {
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
