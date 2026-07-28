import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { build } from 'tsdown';
import { expect, test } from 'vite-plus/test';

import { loadConfig } from '../src/config.ts';
import { generate } from '../src/core/generate.ts';
import { APP_SOURCE, route } from './helpers.ts';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

// Every project here is created inside the package so `@hono/node-server` and
// `hono` resolve by walking up, the way they resolve for an installed app.

test('a Node entry runs the generated router straight from source', async () => {
  await withRuntimeProject('node-source', async (project) => {
    // No build step, no bundler, no plugin: `routes.ts` imports its route
    // modules by relative path with `.ts` intact, and Node's type stripping does
    // the rest.
    const server = await project.run([`${project.root}/src/server.ts`]);
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ runtime: 'node' });
  });
}, 20_000);

test('a Node entry owns its listener and graceful shutdown', async () => {
  await withRuntimeProject('node-shutdown', async (project) => {
    const server = await project.run([`${project.root}/src/server.ts`]);

    // Shinro registers no signal handler anywhere, so SIGTERM reaches the user's
    // own drain and nothing else.
    server.child.kill('SIGTERM');
    await server.waitFor(/STOPPED/);
    await expect(server.exitCode()).resolves.toBe(0);
  });
}, 20_000);

test('the same generated router runs under Bun', async () => {
  await withRuntimeProject('bun-source', async (project) => {
    const server = await project
      .run([`${project.root}/src/server.ts`], 'bun')
      .catch((error: unknown) => {
        // Bun is not part of the toolchain, only a supported runner. Skipping when
        // it is absent keeps the claim honest without pinning CI to it.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return undefined;
        }
        throw error;
      });
    if (!server) {
      return;
    }

    await expect(
      fetch(`http://127.0.0.1:${server.port}/health`).then((r) => r.json())
    ).resolves.toEqual({ runtime: 'node' });
  });
}, 20_000);

test('tsdown builds the app and the generated specifier does not survive', async () => {
  await withRuntimeProject('tsdown-build', async (project) => {
    await build({
      config: false,
      // A server bundle has no consumers to hand types to, and the app's own
      // `tsc` already checked it.
      dts: false,
      entry: [`${project.root}/src/server.ts`],
      format: 'esm',
      outDir: `${project.root}/dist`,
      outExtensions: () => ({ js: '.mjs' }),
      platform: 'node',
      silent: true,
      unbundle: true,
    });

    expect(
      await readFile(`${project.root}/dist/server.mjs`, 'utf8')
    ).not.toContain('#shinro/routes');

    const server = await project.run([`${project.root}/dist/server.mjs`]);
    await expect(
      fetch(`http://127.0.0.1:${server.port}/health`).then((r) => r.json())
    ).resolves.toEqual({ runtime: 'node' });
  });
}, 30_000);

type Server = {
  child: ChildProcess;
  exitCode: () => Promise<number | null>;
  port: number;
  waitFor: (pattern: RegExp) => Promise<RegExpMatchArray>;
};

type RuntimeProject = {
  root: string;
  run: (argv: string[], runner?: string) => Promise<Server>;
};

async function withRuntimeProject(
  name: string,
  body: (project: RuntimeProject) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(`${PACKAGE_ROOT}/.runtime-${name}-`);
  const children: ChildProcess[] = [];

  try {
    await mkdir(`${root}/src/routes`, { recursive: true });
    await writeFile(
      `${root}/package.json`,
      `${JSON.stringify(
        {
          name: `runtime-${name}`,
          type: 'module',
          imports: { '#shinro/routes': './.shinro/routes.ts' },
        },
        undefined,
        2
      )}\n`
    );
    await writeFile(`${root}/src/app.ts`, APP_SOURCE);
    await writeFile(
      `${root}/src/routes/health.ts`,
      route('{ runtime: "node" }')
    );
    await writeFile(
      `${root}/src/server.ts`,
      [
        'import { serve } from "@hono/node-server";',
        'import app from "./app.ts";',
        '',
        'const server = serve({ fetch: app.fetch, port: 0 }, (info) => {',
        '  console.log(`READY:${info.port}`);',
        '});',
        '',
        'process.once("SIGTERM", () => {',
        '  server.close(() => { console.log("STOPPED"); });',
        '});',
        '',
      ].join('\n')
    );

    const logger = { error: () => {}, info: () => {}, warn: () => {} };
    await generate({ config: await loadConfig(root, logger), logger });

    await body({
      root,
      run: async (argv, runner = process.execPath) => {
        const child = spawn(runner, argv, {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        children.push(child);
        const output = collectOutput(child);
        await once(child, 'spawn');
        const port = Number((await output.waitFor(/READY:(\d+)/))[1]);

        return {
          child,
          exitCode: () => exitCode(child),
          port,
          waitFor: output.waitFor,
        };
      },
    });
  } finally {
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }
    await rm(root, { force: true, recursive: true });
  }
}

function once(child: ChildProcess, event: 'spawn'): Promise<void> {
  return new Promise((settle, reject) => {
    child.once(event, () => settle());
    child.once('error', reject);
  });
}

function collectOutput(child: ChildProcess): {
  waitFor: (pattern: RegExp) => Promise<RegExpMatchArray>;
} {
  let output = '';
  const waiters = new Set<() => void>();
  const onData = (chunk: Buffer) => {
    output += chunk.toString();
    for (const notify of waiters) {
      notify();
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  return {
    waitFor(pattern) {
      return new Promise((settle, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`Timed out waiting for ${pattern} in:\n${output}`));
        }, 10_000);
        const check = () => {
          const match = output.match(pattern);
          if (!match) {
            return;
          }
          clearTimeout(timeout);
          waiters.delete(check);
          settle(match);
        };
        waiters.add(check);
        check();
      });
    },
  };
}

function exitCode(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((settle) => {
    child.once('close', settle);
  });
}
