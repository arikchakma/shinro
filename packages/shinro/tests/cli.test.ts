import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vite-plus/test';

import { APP_SOURCE, GET_ROUTE } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

test('the CLI lists its commands when asked for help', async () => {
  const result = await run(['--help']);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain('shinro <command>');
  expect(result.stdout).toContain('generate');
  expect(result.stdout).toContain('init');
});

test('an unknown command names itself and prints usage', async () => {
  const result = await run(['serve']);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain('Unknown command "serve"');
});

test('generate writes the artifacts and reports where', async () => {
  await withCliProject('cli-generate', async (root) => {
    const result = await run(['generate'], root);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('wrote .shinro');
    await expect(
      readFile(`${root}/.shinro/routes.ts`, 'utf8')
    ).resolves.toContain('/health');
  });
});

test('generate summarises rather than listing every route', async () => {
  await withCliProject('cli-summary', async (root) => {
    const quiet = await run(['generate'], root);

    // `generate` runs from `prepare`, so it lands in every install and every CI
    // job. A few hundred routes must not become a few hundred lines there.
    expect(quiet.stdout).toContain('1 route');
    expect(quiet.stdout).not.toContain('└─');
    expect(quiet.stdout.trimEnd().split('\n')).toHaveLength(1);

    const asked = await run(['generate', '--tree'], root);

    expect(asked.code).toBe(0);
    expect(asked.stdout).toContain('└─ health');
  });
});

test('generate says so when there was nothing to write', async () => {
  await withCliProject('cli-idempotent', async (root) => {
    await run(['generate'], root);
    const second = await run(['generate'], root);

    expect(second.code).toBe(0);
    expect(second.stdout).toContain('is up to date');
  });
});

test('typegen still resolves, undocumented, for existing scripts', async () => {
  await withCliProject('cli-typegen', async (root) => {
    const result = await run(['typegen'], root);

    expect(result.code).toBe(0);
    await expect(
      readFile(`${root}/.shinro/routes.ts`, 'utf8')
    ).resolves.toContain('/health');
  });
});

test('--check exits zero on a tree that matches', async () => {
  await withCliProject('cli-check-clean', async (root) => {
    await run(['generate'], root);
    const result = await run(['generate', '--check'], root);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('matches the route tree');
  });
});

test('--check exits non-zero on drift and names the files', async () => {
  await withCliProject('cli-check-drift', async (root) => {
    await run(['generate'], root);
    await writeFile(`${root}/src/routes/extra.ts`, GET_ROUTE);

    const result = await run(['generate', '--check'], root);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('is out of date');
    expect(result.stderr).toContain('.shinro/routes.ts');
  });
});

test('--check exits non-zero on a route conflict, having written nothing', async () => {
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

test('--watch and --check are refused together', async () => {
  await withCliProject('cli-both', async (root) => {
    const result = await run(['generate', '--watch', '--check'], root);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('mutually exclusive');
  });
});

test('an unknown option is named rather than ignored', async () => {
  await withCliProject('cli-unknown-option', async (root) => {
    const result = await run(['generate', '--force'], root);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--force');
  });
});

test('init writes the imports block, the tsconfig, and the scripts', async () => {
  const root = await mkdtemp(`${tmpdir()}/shinro-cli-init-`);

  try {
    await writeFile(
      `${root}/package.json`,
      `${JSON.stringify({ name: 'fresh', type: 'module' }, undefined, 2)}\n`
    );

    const result = await run(['init'], root);
    expect(result.code).toBe(0);

    const packageJson = JSON.parse(
      await readFile(`${root}/package.json`, 'utf8')
    ) as { imports: Record<string, string>; scripts: Record<string, string> };
    expect(packageJson.imports).toEqual({
      '#shinro/client': './.shinro/client.ts',
      '#shinro/routes': './.shinro/routes.ts',
    });
    expect(packageJson.scripts.dev).toBe(
      'node --watch --import shinro/watch src/server.ts'
    );
    expect(packageJson.scripts.prepare).toBe('shinro generate');
    await expect(readFile(`${root}/tsconfig.json`, 'utf8')).resolves.toContain(
      '"extends": "shinro/tsconfig"'
    );

    // Idempotent: onboarding is a command someone runs twice.
    const second = await run(['init'], root);
    expect(second.stdout).toContain('already initialised');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('init merges into an existing imports block rather than refusing', async () => {
  const root = await mkdtemp(`${tmpdir()}/shinro-cli-init-merge-`);

  try {
    await writeFile(
      `${root}/package.json`,
      `${JSON.stringify(
        {
          name: 'existing',
          type: 'module',
          imports: { '#db': './src/db.ts' },
          scripts: { dev: 'bun --watch src/server.ts' },
        },
        undefined,
        2
      )}\n`
    );

    await run(['init'], root);

    const packageJson = JSON.parse(
      await readFile(`${root}/package.json`, 'utf8')
    ) as { imports: Record<string, string>; scripts: Record<string, string> };
    expect(packageJson.imports['#db']).toBe('./src/db.ts');
    expect(packageJson.imports['#shinro/routes']).toBe('./.shinro/routes.ts');
    // A project that chose `bun --watch` has made a decision; init is not the
    // place to overrule it.
    expect(packageJson.scripts.dev).toBe('bun --watch src/server.ts');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('init --dry-run reports the changes without making them', async () => {
  const root = await mkdtemp(`${tmpdir()}/shinro-cli-init-dry-`);

  try {
    await writeFile(
      `${root}/package.json`,
      `${JSON.stringify({ name: 'fresh', type: 'module' }, undefined, 2)}\n`
    );

    const result = await run(['init', '--dry-run'], root);

    expect(result.stdout).toContain('would make these changes');
    expect(await readFile(`${root}/package.json`, 'utf8')).not.toContain(
      '#shinro/routes'
    );
    await expect(readFile(`${root}/tsconfig.json`, 'utf8')).rejects.toThrow();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

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
