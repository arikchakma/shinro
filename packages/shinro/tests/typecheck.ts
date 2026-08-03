import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { loadConfig } from '../src/config.ts';
import { generate } from '../src/core/generate.ts';
import type { GenerateResult } from '../src/core/generate.ts';

const run = promisify(execFile);

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSC = resolve(PACKAGE_ROOT, 'node_modules/.bin/tsc');
const SCRATCH = resolve(PACKAGE_ROOT, 'tests/.tmp-typecheck');

const APP_SOURCE = [
  "import { defineApp } from 'shinro/app';",
  "import { routes } from '#shinro/routes';",
  'export default defineApp().route("/", routes());',
  '',
].join('\n');

const GET_ROUTE = [
  "import { defineHandler } from 'shinro/app';",
  'export const GET = defineHandler((c) => c.json({ ok: true }, 200));',
  '',
].join('\n');

export type TypedProject = {
  check: () => Promise<string>;
  generate: () => Promise<GenerateResult>;
  generated: (path: string) => Promise<string>;
  root: string;
  warnings: string[];
  write: (path: string, contents: string) => Promise<void>;
};

/**
 * A project a real compiler runs over, since generated text cannot show a
 * `tsconfig` missing the globals Hono builds responses from.
 *
 * `types: []` is load-bearing: the package and the example application both set
 * `types`, which is how a config missing `Response` stayed invisible.
 */
export async function withTypedProject(
  name: string,
  body: (project: TypedProject) => Promise<void>,
  options: { compilerOptions?: Record<string, unknown> } = {}
): Promise<void> {
  await mkdir(SCRATCH, { recursive: true });
  const root = await mkdtemp(`${SCRATCH}/${name}-`);
  const warnings: string[] = [];
  const logger = {
    error: () => {},
    info: () => {},
    warn: (message: string) => warnings.push(message),
  };

  const write = async (path: string, contents: string): Promise<void> => {
    const file = resolve(root, path);
    await mkdir(resolve(file, '..'), { recursive: true });
    await writeFile(file, contents);
  };

  try {
    await mkdir(resolve(root, 'node_modules'), { recursive: true });
    await symlink(PACKAGE_ROOT, resolve(root, 'node_modules/shinro'), 'dir');

    await write(
      'package.json',
      `${JSON.stringify(
        {
          name: 'shinro-typed-project',
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
    await write(
      'tsconfig.json',
      `${JSON.stringify(
        {
          extends: 'shinro/tsconfig',
          compilerOptions: { types: [], ...options.compilerOptions },
        },
        undefined,
        2
      )}\n`
    );
    await write('src/app.ts', APP_SOURCE);
    await write('src/routes/health.ts', GET_ROUTE);

    await body({
      check: async () => {
        const result = await run(TSC, ['--noEmit', '--project', root]).catch(
          (error: { stdout?: string; stderr?: string }) => ({
            stdout: error.stdout ?? '',
            stderr: error.stderr ?? '',
          })
        );
        return `${result.stdout}${result.stderr}`;
      },
      generate: async () =>
        generate({ config: await loadConfig(root, logger), logger }),
      generated: (path) => readFile(resolve(root, '.shinro', path), 'utf8'),
      root,
      warnings,
      write,
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}
