import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.ts';
import type { ShinroConfig } from '../src/config.ts';
import { generate } from '../src/core/generate.ts';
import type { GenerateResult } from '../src/core/generate.ts';

/** A throwaway project on disk, plus the one call that drives Shinro over it. */
export type Project = {
  errors: string[];
  generate: (overrides?: ShinroConfig) => Promise<GenerateResult>;
  check: (overrides?: ShinroConfig) => Promise<GenerateResult>;
  generated: (path: string) => Promise<string>;
  manifest: () => Promise<Manifest>;
  outputDirectory: string;
  read: (path: string) => Promise<string>;
  remove: (path: string) => Promise<void>;
  root: string;
  warnings: string[];
  write: (path: string, contents: string) => Promise<void>;
};

export type Manifest = {
  format: number;
  routes: Array<{
    file: string;
    kind: 'methods' | 'sub-router';
    methods?: string[];
    middleware: string[];
    mountPath?: string;
    path?: string;
  }>;
};

/** The package's own `src/app.ts`, as an absolute specifier a temp project can import. */
export const APP_MODULE = fileURLToPath(
  new URL('../src/app.ts', import.meta.url)
);

/** A route module with one GET handler, in the shape the scanner accepts. */
export const GET_ROUTE = [
  `import { defineHandler } from ${JSON.stringify(APP_MODULE)};`,
  'export const GET = defineHandler((c) => c.json({ ok: true }));',
  '',
].join('\n');

export function route(body: string): string {
  return [
    `import { defineHandler } from ${JSON.stringify(APP_MODULE)};`,
    `export const GET = defineHandler((c) => c.json(${body}));`,
    '',
  ].join('\n');
}

export function middleware(count = 1): string {
  return [
    `import { defineMiddleware } from ${JSON.stringify(APP_MODULE)};`,
    'export default defineMiddleware(',
    ...Array.from(
      { length: count },
      () => '  async (_c, next) => { await next(); },'
    ),
    ');',
    '',
  ].join('\n');
}

/** An app module that mounts the router through `#shinro/routes`, the documented
 * specifier, so these projects fail the same way a user's would. */
export const APP_SOURCE = [
  `import { defineApp } from ${JSON.stringify(APP_MODULE)};`,
  'import { routes } from "#shinro/routes";',
  'export default defineApp().route("/", routes());',
  '',
].join('\n');

export async function withProject(
  name: string,
  body: (project: Project) => Promise<void>,
  options: { app?: string; packageJson?: object } = {}
): Promise<void> {
  const root = await mkdtemp(`${tmpdir()}/shinro-${name}-`);
  const warnings: string[] = [];
  const errors: string[] = [];
  const logger = {
    error: (message: string) => errors.push(message),
    info: () => {},
    warn: (message: string) => warnings.push(message),
  };

  const write = async (path: string, contents: string): Promise<void> => {
    const file = resolve(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents);
  };

  await mkdir(`${root}/src/routes`, { recursive: true });
  await write(
    'package.json',
    `${JSON.stringify(
      options.packageJson ?? {
        name: 'shinro-test-project',
        type: 'module',
        imports: {
          '#shinro/routes': './.shinro/routes.ts',
          '#shinro/client': './.shinro/client.ts',
        },
      },
      undefined,
      2
    )}\n`
  );
  await write('src/app.ts', options.app ?? APP_SOURCE);

  const run = async (
    overrides: ShinroConfig | undefined,
    check: boolean
  ): Promise<GenerateResult> =>
    generate({
      check,
      config: await loadConfig(root, logger, overrides),
      logger,
    });

  try {
    await body({
      errors,
      generate: (overrides) => run(overrides, false),
      check: (overrides) => run(overrides, true),
      generated: (path) => readFile(resolve(root, '.shinro', path), 'utf8'),
      manifest: async () =>
        JSON.parse(
          await readFile(resolve(root, '.shinro/manifest.json'), 'utf8')
        ) as Manifest,
      outputDirectory: resolve(root, '.shinro'),
      read: (path) => readFile(resolve(root, path), 'utf8'),
      remove: (path) => rm(resolve(root, path), { force: true }),
      root,
      warnings,
      write,
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}
