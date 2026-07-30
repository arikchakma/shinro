import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vite-plus/test';

import { loadConfig } from '../src/config.ts';
import type { createLogger } from '../src/core/logger.ts';
import { watch } from '../src/core/watch.ts';
import { APP_SOURCE, GET_ROUTE, route, withProject } from './helpers.ts';

const WATCH_PRELOAD = fileURLToPath(
  new URL('../src/watch.ts', import.meta.url)
);
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('the watcher picks up a brand-new route file', async () => {
  await withProject('watch-new-route', async (project) => {
    await project.write('src/routes/health.ts', route('{ ok: true }'));
    const runs: { changed: string[]; wrote: number }[] = [];
    const watcher = await watch({
      config: await loadConfig(project.root, silentLogger()),
      logger: silentLogger(),
      onGenerate: (result, changed) => {
        runs.push({ changed, wrote: result.written.length });
      },
    });

    try {
      await project.write('src/routes/added.ts', GET_ROUTE);

      // The gap a graph watcher structurally cannot close: nothing imports the
      // new file yet, so only a directory watcher can see it — and once it
      // regenerates, `routes.ts` changes, which every graph watcher already sees.
      await waitFor(async () =>
        (await project.generated('routes.ts')).includes('/added')
      );

      // Editing a handler body changes nothing in `.shinro` — `routes.ts` only
      // imports the file. That is the most common edit in a dev loop, and
      // gating the callback on drift made it the silent one. Asserted on this
      // watcher rather than a fourth of its own: every extra concurrent
      // watcher in this file slows all of them under a parallel suite.
      await project.write('src/routes/health.ts', route('{ ok: false }'));

      await waitFor(() => runs.some((run) => run.wrote === 0));
      const quiet = runs.find((run) => run.wrote === 0);
      expect(quiet?.changed.some((file) => file.endsWith('health.ts'))).toBe(
        true
      );
    } finally {
      await watcher.close();
    }
  });
}, 20_000);

test('the watcher ignores files that cannot change the route tree', async () => {
  await withProject('watch-noise', async (project) => {
    await project.write('src/routes/health.ts', GET_ROUTE);
    let watching = false;
    const watcher = await watch({
      config: await loadConfig(project.root, silentLogger()),
      logger: silentLogger(),
      onGenerate: () => {
        if (watching) {
          throw new Error('regenerated for a file that is not a route');
        }
      },
    });
    watching = true;

    try {
      await project.write('src/routes/README.md', '# notes\n');
      await project.write('src/routes/health.test.ts', GET_ROUTE);
      await project.write('src/routes/-health-body.ts', GET_ROUTE);
      await new Promise((settle) => setTimeout(settle, 250));
    } finally {
      await watcher.close();
    }
  });
}, 15_000);

test('a broken tree is reported and the previous generation keeps serving', async () => {
  await withProject('watch-broken', async (project) => {
    await project.write('src/routes/health.ts', route('{ ok: true }'));
    const errors: string[] = [];
    const watcher = await watch({
      config: await loadConfig(project.root, silentLogger()),
      logger: { ...silentLogger(), error: (message) => errors.push(message) },
    });
    const before = await project.generated('routes.ts');

    try {
      await project.write('src/routes/health/index.ts', GET_ROUTE);
      await waitFor(() => errors.some((line) => /Route conflict/.test(line)));

      // A typo mid-edit is a normal state in a dev loop. Crash-looping the
      // runner over it is worse than serving a stale route for two seconds.
      expect(await project.generated('routes.ts')).toBe(before);

      await project.remove('src/routes/health/index.ts');
      await project.write('src/routes/recovered.ts', GET_ROUTE);
      await waitFor(async () =>
        (await project.generated('routes.ts')).includes('/recovered')
      );
    } finally {
      await watcher.close();
    }
  });
}, 15_000);

test('the watcher installs no signal handlers and spawns nothing', async () => {
  await withProject('watch-invariants', async (project) => {
    await project.write('src/routes/health.ts', GET_ROUTE);
    const before = {
      sigint: process.listenerCount('SIGINT'),
      sigterm: process.listenerCount('SIGTERM'),
    };

    const watcher = await watch({
      config: await loadConfig(project.root, silentLogger()),
      logger: silentLogger(),
    });

    try {
      // Node owns the process. The moment Shinro takes a signal handler or a
      // child process, it owes the user SIGTERM semantics — which is exactly the
      // `shinro dev` this design deleted.
      expect(process.listenerCount('SIGINT')).toBe(before.sigint);
      expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
    } finally {
      await watcher.close();
    }
  });
}, 15_000);

test('the preload refuses to start a server it could not generate for', async () => {
  const root = await mkdtemp(`${tmpdir()}/shinro-cold-clone-`);

  try {
    await mkdir(`${root}/src/routes/health`, { recursive: true });
    await writeFile(
      `${root}/package.json`,
      `${JSON.stringify({ name: 'cold', type: 'module' }, undefined, 2)}\n`
    );
    await writeFile(`${root}/src/app.ts`, APP_SOURCE);
    await writeFile(`${root}/src/server.ts`, 'import "./app.ts";\n');
    // A conflict, and no previous generation to fall back on.
    await writeFile(`${root}/src/routes/health.ts`, GET_ROUTE);
    await writeFile(`${root}/src/routes/health/index.ts`, GET_ROUTE);

    const result = await runNode(
      ['--import', WATCH_PRELOAD, `${root}/src/server.ts`],
      root
    );

    expect(result.code).not.toBe(0);
    expect(result.output).toContain('Route conflict');
    expect(result.output).toContain('Nothing has been generated yet');
    // Without this the cold clone would fail as Node's error about a missing
    // module, which says nothing about the route conflict that caused it.
    expect(result.output).not.toContain('ERR_MODULE_NOT_FOUND');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 20_000);

test('the preload never keeps a drained server process alive', async () => {
  const root = await mkdtemp(`${PACKAGE_ROOT}/.drain-`);
  let child: ChildProcess | undefined;

  try {
    await mkdir(`${root}/src/routes`, { recursive: true });
    await writeFile(
      `${root}/package.json`,
      `${JSON.stringify(
        {
          name: 'drain',
          type: 'module',
          imports: { '#shinro/routes': './.shinro/routes.ts' },
        },
        undefined,
        2
      )}\n`
    );
    await writeFile(`${root}/src/app.ts`, APP_SOURCE);
    await writeFile(`${root}/src/routes/health.ts`, GET_ROUTE);
    // The shape almost every real server has: close the listener on SIGTERM and
    // let the process end on its own, with no `process.exit`.
    await writeFile(
      `${root}/src/server.ts`,
      [
        'import { serve } from "@hono/node-server";',
        'import app from "./app.ts";',
        '',
        'const server = serve({ fetch: app.fetch, port: 0 }, () => {',
        '  console.log("READY");',
        '});',
        '',
        'process.once("SIGTERM", () => { server.close(); });',
        '',
      ].join('\n')
    );

    child = spawn(
      process.execPath,
      ['--import', WATCH_PRELOAD, `${root}/src/server.ts`],
      {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const output = collectOutput(child);
    await output.waitFor(/READY/);

    child.kill('SIGTERM');

    // A referenced `fs.watch` handle would hold the event loop open here, and
    // `node --watch` would sit on "waiting for graceful termination" before
    // force-killing — one restart turning into a several-second stall.
    await expect(
      new Promise<number | null>((settle) => child?.once('close', settle))
    ).resolves.toBe(0);
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
    }
    await rm(root, { force: true, recursive: true });
  }
}, 20_000);

test('node --watch plus the preload restarts once for a brand-new route', async () => {
  // Inside the package so the temp project resolves @hono/node-server and hono
  // by walking up, the way an installed project resolves its own dependencies.
  const root = await mkdtemp(`${PACKAGE_ROOT}/.dev-loop-`);
  let child: ChildProcess | undefined;

  try {
    await mkdir(`${root}/src/routes`, { recursive: true });
    await writeFile(
      `${root}/package.json`,
      `${JSON.stringify(
        {
          name: 'dev-loop',
          type: 'module',
          imports: { '#shinro/routes': './.shinro/routes.ts' },
        },
        undefined,
        2
      )}\n`
    );
    await writeFile(`${root}/src/app.ts`, APP_SOURCE);
    await writeFile(`${root}/src/routes/health.ts`, GET_ROUTE);
    await writeFile(
      `${root}/src/server.ts`,
      [
        'import { serve } from "@hono/node-server";',
        'import app from "./app.ts";',
        'serve({ fetch: app.fetch, port: 0 }, (info) => {',
        '  console.log(`READY:${info.port}`);',
        '});',
        '',
      ].join('\n')
    );

    child = spawn(
      process.execPath,
      ['--watch', '--import', WATCH_PRELOAD, `${root}/src/server.ts`],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const output = collectOutput(child);
    const firstPort = Number((await output.waitFor(/READY:(\d+)/))[1]);
    await expect(
      fetch(`http://127.0.0.1:${firstPort}/added`).then((r) => r.status)
    ).resolves.toBe(404);

    await writeFile(`${root}/src/routes/added.ts`, GET_ROUTE);

    // One restart, and the new route is served: the watcher writes `routes.ts`,
    // `routes.ts` is in the graph, `--watch` restarts, the preload re-runs.
    const secondPort = Number(
      (await output.waitFor(/READY:(\d+)[\s\S]*READY:(\d+)/))[2]
    );
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${secondPort}/added`);
      return response.status === 200;
    });

    await new Promise((settle) => setTimeout(settle, 1_500));
    expect(output.matches(/READY:/g)).toHaveLength(2);
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGKILL');
    }
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

function silentLogger(): ReturnType<typeof createLogger> {
  return { error: () => {}, info: () => {}, warn: () => {} };
}

/**
 * The default is most of the 15s budget these tests declare, not a third of it.
 * Every caller is waiting on a real `fs.watch` event plus a full scan, and the
 * suite runs nine files at once — a tight inner deadline turns ordinary
 * contention into a failure that looks like a dropped event.
 */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout = 12_000
): Promise<void> {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      if (await condition()) {
        return;
      }
    } catch {
      // The file may not exist yet; keep waiting.
    }
    await new Promise((settle) => setTimeout(settle, 50));
  }

  throw new Error(`Timed out after ${timeout}ms waiting for a condition`);
}

function runNode(
  argv: string[],
  cwd: string
): Promise<{ code: number | null; output: string }> {
  return new Promise((settle, reject) => {
    const child = spawn(process.execPath, argv, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';

    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => settle({ code, output }));
  });
}

function collectOutput(child: ChildProcess): {
  matches: (pattern: RegExp) => RegExpMatchArray[];
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
    matches: (pattern) => [...output.matchAll(pattern)],
    waitFor(pattern) {
      return new Promise((settle, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`Timed out waiting for ${pattern} in:\n${output}`));
        }, 15_000);
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
