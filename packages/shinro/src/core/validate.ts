import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import {
  CLIENT_FILE,
  CLIENT_SPECIFIER,
  OUTPUT_DIRECTORY,
  ROUTES_FILE,
  ROUTES_SPECIFIER,
} from '../constants.ts';
import type { ShinroLogger } from './logger.ts';
import { toRelativeSpecifier } from './path.ts';

/**
 * Warns unless the project's tsconfig knows about the generated types, which is
 * the one question worth asking: `${configDir}` in the shipped base config
 * carries `rootDirs` and `include` for everyone who extends it.
 */
export async function validateTypeScriptConfig(options: {
  logger: ShinroLogger;
  root: string;
}): Promise<void> {
  const file = resolve(options.root, 'tsconfig.json');
  let source: string;

  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    // A project with no tsconfig is a project not using tsc, which is a
    // supported way to run Shinro. Nothing to check.
    return;
  }

  // Read as text rather than parsed: tsconfig is JSONC, and a JSONC parser plus
  // an extends-chain resolver is a lot of dependency for a question the string
  // already answers.
  //
  // Two spellings pass. Extending the shipped base is the recommended one. Naming
  // the generated types directory yourself is the other — a project that wired
  // `rootDirs` by hand, or extends a base of its own that does, has answered the
  // question and does not need advice about it.
  const extendsShippedBase =
    /"extends"\s*:\s*(?:"shinro\/tsconfig|\[[^\]]*"shinro\/tsconfig)/.test(
      source
    );
  if (extendsShippedBase || source.includes(`${OUTPUT_DIRECTORY}/types`)) {
    return;
  }

  options.logger.warn(
    `[shinro] ${file} does not extend "shinro/tsconfig", so rootDirs and include are unset and the generated "+types" declarations will not resolve. Add { "extends": "shinro/tsconfig" }, or copy rootDirs and include from it.`
  );
}

/**
 * `#shinro/*` has to be declared in the app's package.json `imports`, so warn
 * with the exact snippet when it is missing or points somewhere other than
 * `.shinro`. `shinro init` writes the block, so this warning is for hand-wired
 * projects and for someone who edited it by hand.
 *
 * A relative import is NOT a mistake and must never warn. `import { routes } from
 * '../.shinro/routes.ts'` needs no package.json at all and resolves in every
 * runner and in tsc by construction — it is the escape hatch for anyone whose
 * package.json is generated or locked down. `#shinro/routes` is the documented
 * default only because it survives moving `app.ts`.
 */
export async function validatePackageImports(options: {
  logger: ShinroLogger;
  outputDirectory: string;
  root: string;
}): Promise<void> {
  const file = resolve(options.root, 'package.json');
  let packageJson: { imports?: unknown };

  try {
    packageJson = JSON.parse(await readFile(file, 'utf8')) as {
      imports?: unknown;
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      options.logger.warn(
        `[shinro] Could not read ${file}, so its imports block was not checked: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    return;
  }

  const imports =
    typeof packageJson.imports === 'object' &&
    packageJson.imports !== null &&
    !Array.isArray(packageJson.imports)
      ? (packageJson.imports as Record<string, unknown>)
      : {};

  const expected = new Map([
    [ROUTES_SPECIFIER, importTarget(options, ROUTES_FILE)],
    [CLIENT_SPECIFIER, importTarget(options, CLIENT_FILE)],
  ]);
  const wrong = [...expected].filter(
    ([specifier, target]) =>
      specifier in imports && !pointsTo(imports[specifier], target)
  );
  const missing = [...expected].filter(
    ([specifier]) => !(specifier in imports)
  );

  // Nothing declared at all is the cold-clone case: the app may well import the
  // generated file by relative path, which needs no declaration and is not worth
  // a warning on every generation. A half-declared block is different — someone
  // meant to use the specifiers.
  if (missing.length === expected.size && wrong.length === 0) {
    return;
  }

  for (const [specifier, target] of wrong) {
    options.logger.warn(
      `[shinro] ${file} declares ${JSON.stringify(specifier)} pointing somewhere other than ${JSON.stringify(
        target
      )}. Shinro always generates into ".shinro"; point the specifier at it or drop it and import the file by relative path.`
    );
  }

  if (missing.length > 0 && missing.length !== expected.size) {
    options.logger.warn(
      [
        `[shinro] ${file} is missing ${missing
          .map(([specifier]) => JSON.stringify(specifier))
          .join(' and ')} in its "imports" block. Add:`,
        '  "imports": {',
        [...expected]
          .map(
            ([specifier, target]) =>
              `    ${JSON.stringify(specifier)}: ${JSON.stringify(target)}`
          )
          .join(',\n'),
        '  }',
      ].join('\n')
    );
  }
}

function importTarget(
  options: { outputDirectory: string; root: string },
  name: string
): string {
  return toRelativeSpecifier(
    relative(options.root, resolve(options.outputDirectory, name))
      .split(sep)
      .join('/')
  );
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
