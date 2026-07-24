import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, relative, resolve, sep } from 'node:path';

import type { Logger } from 'vite-plus';

type TypeScriptConfig = {
  compilerOptions?: {
    allowImportingTsExtensions?: boolean;
    emitDeclarationOnly?: boolean;
    module?: string;
    moduleResolution?: string;
    noEmit?: boolean;
    rewriteRelativeImportExtensions?: boolean;
    rootDirs?: string[];
    strict?: boolean;
  };
  extends?: string | string[];
  include?: string[];
};

const DEFAULT_OUTPUT_DIRECTORY = '.daroyan';

export async function validateTypeScriptConfig(options: {
  logger: Logger;
  outputDirectory: string;
  root: string;
}): Promise<void> {
  const file = resolve(options.root, 'tsconfig.json');
  let config: TypeScriptConfig | undefined;
  let missing = false;

  try {
    config = await readTypeScriptConfig(file, new Set());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      config = {};
      missing = true;
    } else {
      return;
    }
  }
  if (!config) {
    return;
  }

  const generatedDirectory = relative(options.root, options.outputDirectory)
    .split(sep)
    .join('/');
  const generatedTypes = normalizeConfigPath(`./${generatedDirectory}/types`);
  const rootDirs =
    config.compilerOptions?.rootDirs?.map(normalizeConfigPath) ?? [];
  const includes = config.include?.map(normalizeConfigPath) ?? [];
  const supportsTypeScriptImportExtensions =
    config.compilerOptions?.allowImportingTsExtensions === true &&
    (config.compilerOptions.noEmit === true ||
      config.compilerOptions.emitDeclarationOnly === true ||
      config.compilerOptions.rewriteRelativeImportExtensions === true);
  // `preserve` is the modern companion to `moduleResolution: bundler` and
  // behaves identically for Daroyan's purposes, so accept it alongside
  // `esnext` rather than warning about a perfectly good configuration.
  const moduleSetting = config.compilerOptions?.module?.toLowerCase();
  const valid =
    config.compilerOptions?.strict === true &&
    (moduleSetting === 'esnext' || moduleSetting === 'preserve') &&
    config.compilerOptions.moduleResolution?.toLowerCase() === 'bundler' &&
    supportsTypeScriptImportExtensions &&
    rootDirs.includes('.') &&
    rootDirs.includes(generatedTypes) &&
    // The ambient `modules.d.ts` only takes effect when it is part of the
    // program, and TypeScript's `**/*.ts` glob does not match `.d.ts`, so a
    // declaration-matching pattern is the load-bearing one here.
    includes.some((include) =>
      [
        `${normalizeConfigPath(generatedDirectory)}/**/*.d.ts`,
        `${normalizeConfigPath(generatedDirectory)}/**/*`,
      ].includes(include)
    );

  if (valid) {
    return;
  }

  // The shipped base config hardcodes the default `.daroyan` location, so it
  // can only be recommended when the project actually generates there.
  const shippedBaseApplies = generatedDirectory === DEFAULT_OUTPUT_DIRECTORY;

  options.logger.warn(
    [
      missing
        ? `[daroyan] ${file} is missing. Daroyan needs TypeScript configuration for generated route types.`
        : `[daroyan] ${file} is missing settings required for generated route types.`,
      ...(shippedBaseApplies
        ? [
            'Extend the shipped base configuration:',
            JSON.stringify({ extends: 'daroyan/tsconfig' }, undefined, 2),
            'Or merge this configuration manually:',
          ]
        : [
            `Because rpc.outDir is ${JSON.stringify(
              generatedDirectory
            )} rather than ${JSON.stringify(
              DEFAULT_OUTPUT_DIRECTORY
            )}, the shipped daroyan/tsconfig base does not match this project. Merge this configuration instead:`,
          ]),
      JSON.stringify(
        {
          compilerOptions: {
            allowImportingTsExtensions: true,
            strict: true,
            module: 'ESNext',
            moduleResolution: 'Bundler',
            noEmit: true,
            rootDirs: ['.', `./${generatedDirectory}/types`],
          },
          include: [
            'src',
            `${generatedDirectory}/**/*.d.ts`,
            `${generatedDirectory}/**/*.ts`,
          ],
        },
        undefined,
        2
      ),
    ].join('\n')
  );
}

async function readTypeScriptConfig(
  file: string,
  seen: Set<string>
): Promise<TypeScriptConfig | undefined> {
  if (seen.has(file)) {
    return undefined;
  }
  seen.add(file);

  const source = await readFile(file, 'utf8');
  const config = JSON.parse(stripJsonComments(source)) as TypeScriptConfig;
  if (!config.extends) {
    return config;
  }

  // TypeScript 5.0 allows `extends` to be a list, where later entries win.
  const parents = Array.isArray(config.extends)
    ? config.extends
    : [config.extends];
  let merged: TypeScriptConfig = {};

  for (const parent of parents) {
    if (typeof parent !== 'string') {
      continue;
    }

    const baseFile = resolveExtends(file, parent);
    const base = baseFile
      ? await readTypeScriptConfig(baseFile, seen)
      : undefined;
    if (!base) {
      continue;
    }

    merged = {
      ...merged,
      ...base,
      compilerOptions: {
        ...merged.compilerOptions,
        ...base.compilerOptions,
      },
    };
  }

  return {
    ...merged,
    ...config,
    compilerOptions: {
      ...merged.compilerOptions,
      ...config.compilerOptions,
    },
  };
}

function resolveExtends(file: string, parent: string): string | undefined {
  if (parent.startsWith('.') || parent.startsWith('/')) {
    const unresolvedBase = resolve(dirname(file), parent);
    return extname(unresolvedBase) ? unresolvedBase : `${unresolvedBase}.json`;
  }

  try {
    return createRequire(file).resolve(parent);
  } catch {
    return undefined;
  }
}

function normalizeConfigPath(path: string): string {
  return (
    path
      .replace(/\\/g, '/')
      .replace(/^\$\{configDir\}\/?/, '')
      .replace(/^\.\//, '')
      .replace(/\/+$/, '') || '.'
  );
}

function stripJsonComments(source: string): string {
  let output = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') {
        index += 1;
      }
      output += '\n';
      continue;
    }
    if (character === '/' && next === '*') {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === '*' && source[index + 1] === '/')
      ) {
        if (source[index] === '\n') {
          output += '\n';
        }
        index += 1;
      }
      index += 1;
      continue;
    }

    output += character;
  }

  return output.replace(/,\s*([}\]])/g, '$1');
}
