import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vite-plus/test';

import { APP_SOURCE, GET_ROUTE } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

test('the CLI names its commands, and names what it does not recognise', async () => {
  const help = await run(['--help']);

  expect(help.code).toBe(0);
  expect(help.stdout).toContain('shinro <command>');
  expect(help.stdout).toContain('generate');
  expect(help.stdout).toContain('init');

  const unknown = await run(['serve']);

  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain('Unknown command "serve"');

  await withCliProject('cli-options', async (root) => {
    const both = await run(['generate', '--watch', '--check'], root);
    expect(both.code).toBe(1);
    expect(both.stderr).toContain('mutually exclusive');

    const option = await run(['generate', '--force'], root);
    expect(option.code).toBe(1);
    expect(option.stderr).toContain('--force');
  });
});

test('generate reports where it wrote, summarises, and repeats cleanly', async () => {
  await withCliProject('cli-generate', async (root) => {
    const first = await run(['generate'], root);

    expect(first.code).toBe(0);
    expect(first.stdout).toContain('wrote .shinro');
    await expect(
      readFile(`${root}/.shinro/routes.ts`, 'utf8')
    ).resolves.toContain('/health');

    // `generate` runs from `prepare`, so it lands in every install and every CI
    // job. A few hundred routes must not become a few hundred lines there.
    expect(first.stdout).toContain('1 route');
    expect(first.stdout).not.toContain('└─');
    expect(first.stdout.trimEnd().split('\n')).toHaveLength(1);

    const second = await run(['generate'], root);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('is up to date');

    const asked = await run(['generate', '--tree'], root);
    expect(asked.code).toBe(0);
    expect(asked.stdout).toContain('└─ health');

    expect((await run(['typegen'], root)).code).toBe(0);
  });
});

test('--check exits non-zero on drift or conflict, and writes nothing', async () => {
  await withCliProject('cli-check', async (root) => {
    await run(['generate'], root);
    const clean = await run(['generate', '--check'], root);

    expect(clean.code).toBe(0);
    expect(clean.stdout).toContain('matches the route tree');

    await writeFile(`${root}/src/routes/extra.ts`, GET_ROUTE);
    const drifted = await run(['generate', '--check'], root);

    expect(drifted.code).toBe(1);
    expect(drifted.stderr).toContain('is out of date');
    expect(drifted.stderr).toContain('.shinro/routes.ts');
  });

  await withCliProject('cli-check-conflict', async (root) => {
    await mkdir(`${root}/src/routes/health`, { recursive: true });
    await writeFile(`${root}/src/routes/health/index.ts`, GET_ROUTE);

    const result = await run(['generate', '--check'], root);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Route conflict');
    await expect(
      readFile(`${root}/.shinro/routes.ts`, 'utf8')
    ).rejects.toThrow();
  });
});

test('init wires the project up without overruling its existing choices', async () => {
  await withEmptyProject({ name: 'fresh', type: 'module' }, async (root) => {
    const result = await run(['init'], root);
    expect(result.code).toBe(0);

    const packageJson = await readPackageJson(root);
    expect(packageJson.imports).toEqual({
      '#shinro/client': './.shinro/client.ts',
      '#shinro/routes': './.shinro/routes.ts',
    });
    expect(packageJson.scripts.dev).toBe(
      'node --watch --watch-preserve-output --import shinro/watch src/server.ts'
    );
    expect(packageJson.scripts.prepare).toBe('shinro generate');
    await expect(readFile(`${root}/tsconfig.json`, 'utf8')).resolves.toContain(
      '"extends": "shinro/tsconfig"'
    );

    const second = await run(['init'], root);
    expect(second.stdout).toContain('already initialised');
  });

  await withEmptyProject(
    {
      name: 'existing',
      type: 'module',
      imports: { '#db': './src/db.ts' },
      scripts: { dev: 'bun --watch src/server.ts' },
    },
    async (root) => {
      await run(['init'], root);

      const packageJson = await readPackageJson(root);
      expect(packageJson.imports['#db']).toBe('./src/db.ts');
      expect(packageJson.imports['#shinro/routes']).toBe('./.shinro/routes.ts');
      expect(packageJson.scripts.dev).toBe('bun --watch src/server.ts');
    }
  );

  await withEmptyProject({ name: 'fresh', type: 'module' }, async (root) => {
    const result = await run(['init', '--dry-run'], root);

    expect(result.stdout).toContain('would make these changes');
    expect(await readFile(`${root}/package.json`, 'utf8')).not.toContain(
      '#shinro/routes'
    );
    await expect(readFile(`${root}/tsconfig.json`, 'utf8')).rejects.toThrow();
  });
});

async function readPackageJson(root: string): Promise<{
  imports: Record<string, string>;
  scripts: Record<string, string>;
}> {
  return JSON.parse(await readFile(`${root}/package.json`, 'utf8')) as {
    imports: Record<string, string>;
    scripts: Record<string, string>;
  };
}

async function withEmptyProject(
  packageJson: object,
  body: (root: string) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(`${tmpdir()}/shinro-cli-init-`);

  try {
    await writeFile(
      `${root}/package.json`,
      `${JSON.stringify(packageJson, undefined, 2)}\n`
    );
    await body(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function withCliProject(
  name: string,
  body: (root: string) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(`${tmpdir()}/shinro-${name}-`);

  try {
    await mkdir(`${root}/src/routes`, { recursive: true });
    await writeFile(
      `${root}/package.json`,
      `${JSON.stringify(
        {
          name: 'cli-test-project',
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
    await writeFile(`${root}/src/app.ts`, APP_SOURCE);
    await writeFile(`${root}/src/routes/health.ts`, GET_ROUTE);
    await body(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function run(
  argv: string[],
  cwd = fileURLToPath(new URL('..', import.meta.url))
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolvePromise({ code, stderr, stdout });
    });
  });
}
