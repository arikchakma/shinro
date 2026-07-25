import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createServer } from 'vite-plus';
import { expect, test } from 'vite-plus/test';

test('development reloads the isolated user entry and terminates each process normally', async () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const root = await mkdtemp(`${packageRoot}/.shinro-development-`);
  const plugin = fileURLToPath(new URL('../src/index.ts', import.meta.url));
  const appHelper = fileURLToPath(new URL('../src/app.ts', import.meta.url));
  const lifecycleFile = `${root}/lifecycle.log`;

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(
    `${root}/vite.config.ts`,
    [
      `import { shinro } from ${JSON.stringify(plugin)};`,
      'import { defineConfig } from "vite-plus";',
      'export default defineConfig({ plugins: [shinro()] });',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/app.ts`,
    [
      `import { defineApp } from ${JSON.stringify(appHelper)};`,
      'import { routes } from "shinro/routes";',
      'export default defineApp().route("/", routes());',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/routes/health.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );
  await writeFile(
    `${root}/src/server.ts`,
    [
      'import { appendFileSync } from "node:fs";',
      'import app from "./app.ts";',
      `const lifecycleFile = ${JSON.stringify(lifecycleFile)};`,
      'appendFileSync(lifecycleFile, "STARTED\\n");',
      'process.once("SIGTERM", () => {',
      '  appendFileSync(lifecycleFile, "STOPPED\\n");',
      '  process.exit(0);',
      '});',
      'setInterval(() => {}, 1_000);',
      'export default app;',
      '',
    ].join('\n')
  );

  const server = await createServer({
    configFile: `${root}/vite.config.ts`,
    root,
    server: { port: 0 },
  });

  try {
    await server.listen();
    await expect
      .poll(async () => readFile(lifecycleFile, 'utf8'), { timeout: 5_000 })
      .toContain('STARTED');

    await writeFile(
      `${root}/src/routes/notes.ts`,
      'export const GET = [(c: any) => c.json({ resource: "notes" })] as const;\n'
    );
    await expect
      .poll(async () => readFile(lifecycleFile, 'utf8'), { timeout: 5_000 })
      .toBe('STARTED\nSTOPPED\nSTARTED\n');
  } finally {
    await server.close();
  }

  try {
    await expect
      .poll(async () => readFile(lifecycleFile, 'utf8'), { timeout: 5_000 })
      .toBe('STARTED\nSTOPPED\nSTARTED\nSTOPPED\n');
  } finally {
    await rm(root, { recursive: true });
  }
}, 15_000);

test('editing route code reloads its behavior without rewriting the route manifest', async () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const root = await mkdtemp(`${packageRoot}/.shinro-development-code-edit-`);
  const plugin = fileURLToPath(new URL('../src/index.ts', import.meta.url));
  const appHelper = fileURLToPath(new URL('../src/app.ts', import.meta.url));
  const observationsFile = `${root}/observations.log`;
  const manifestFile = `${root}/.shinro/manifest.json`;
  const unchangedTime = new Date('2020-01-02T03:04:05.000Z');

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(
    `${root}/vite.config.ts`,
    [
      `import { shinro } from ${JSON.stringify(plugin)};`,
      'import { defineConfig } from "vite-plus";',
      'export default defineConfig({ plugins: [shinro()] });',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/app.ts`,
    [
      `import { defineApp } from ${JSON.stringify(appHelper)};`,
      'import { routes } from "shinro/routes";',
      'export default defineApp().route("/", routes());',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/routes/health.ts`,
    'export const GET = [(c: any) => c.json({ version: 1 })] as const;\n'
  );
  await writeFile(
    `${root}/src/server.ts`,
    [
      'import { appendFileSync } from "node:fs";',
      'import app from "./app.ts";',
      `const observationsFile = ${JSON.stringify(observationsFile)};`,
      'const response = await app.request("/health");',
      'const body = await response.json();',
      'appendFileSync(observationsFile, `VERSION:${body.version}\\n`);',
      'process.once("SIGTERM", () => process.exit(0));',
      'setInterval(() => {}, 1_000);',
      '',
    ].join('\n')
  );

  const server = await createServer({
    configFile: `${root}/vite.config.ts`,
    root,
    server: { port: 0 },
  });

  try {
    await server.listen();
    await expect
      .poll(async () => readFile(observationsFile, 'utf8'), { timeout: 5_000 })
      .toBe('VERSION:1\n');

    await utimes(manifestFile, unchangedTime, unchangedTime);
    await writeFile(
      `${root}/src/routes/health.ts`,
      'export const GET = [(c: any) => c.json({ version: 2 })] as const;\n'
    );

    await expect
      .poll(async () => readFile(observationsFile, 'utf8'), { timeout: 5_000 })
      .toBe('VERSION:1\nVERSION:2\n');
    expect((await stat(manifestFile)).mtimeMs).toBe(unchangedTime.getTime());
  } finally {
    await server.close();
    await rm(root, { recursive: true });
  }
}, 15_000);

test('an invalid structural route change keeps the last-known-good server running', async () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const root = await mkdtemp(`${packageRoot}/.shinro-development-conflict-`);
  const plugin = fileURLToPath(new URL('../src/index.ts', import.meta.url));
  const appHelper = fileURLToPath(new URL('../src/app.ts', import.meta.url));
  const lifecycleFile = `${root}/lifecycle.log`;

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(
    `${root}/vite.config.ts`,
    [
      `import { shinro } from ${JSON.stringify(plugin)};`,
      'import { defineConfig } from "vite-plus";',
      'export default defineConfig({ plugins: [shinro()] });',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/app.ts`,
    [
      `import { defineApp } from ${JSON.stringify(appHelper)};`,
      'import { routes } from "shinro/routes";',
      'export default defineApp().route("/", routes());',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/routes/users.ts`,
    'export const GET = [(c: any) => c.json({ source: "file" })] as const;\n'
  );
  await writeFile(
    `${root}/src/server.ts`,
    [
      'import { appendFileSync } from "node:fs";',
      'import app from "./app.ts";',
      `const lifecycleFile = ${JSON.stringify(lifecycleFile)};`,
      'appendFileSync(lifecycleFile, "STARTED\\n");',
      'process.once("SIGTERM", () => {',
      '  appendFileSync(lifecycleFile, "STOPPED\\n");',
      '  process.exit(0);',
      '});',
      'setInterval(() => {}, 1_000);',
      'export default app;',
      '',
    ].join('\n')
  );

  const server = await createServer({
    configFile: `${root}/vite.config.ts`,
    root,
    server: { port: 0 },
  });

  try {
    await server.listen();
    await expect
      .poll(async () => readFile(lifecycleFile, 'utf8'), { timeout: 5_000 })
      .toBe('STARTED\n');

    await mkdir(`${root}/src/routes/users`, { recursive: true });
    await writeFile(
      `${root}/src/routes/users/index.ts`,
      'export const GET = [(c: any) => c.json({ source: "index" })] as const;\n'
    );
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(await readFile(lifecycleFile, 'utf8')).toBe('STARTED\n');
  } finally {
    await server.close();
  }

  try {
    await expect
      .poll(async () => readFile(lifecycleFile, 'utf8'), { timeout: 5_000 })
      .toBe('STARTED\nSTOPPED\n');
  } finally {
    await rm(root, { recursive: true });
  }
}, 15_000);

test('development fails immediately with guidance when the server entry is missing', async () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const root = await mkdtemp(
    `${packageRoot}/.shinro-development-missing-entry-`
  );
  const plugin = fileURLToPath(new URL('../src/index.ts', import.meta.url));
  const appHelper = fileURLToPath(new URL('../src/app.ts', import.meta.url));

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(
    `${root}/vite.config.ts`,
    [
      `import { shinro } from ${JSON.stringify(plugin)};`,
      'import { defineConfig } from "vite-plus";',
      'export default defineConfig({ plugins: [shinro()] });',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/app.ts`,
    [
      `import { defineApp } from ${JSON.stringify(appHelper)};`,
      'import { routes } from "shinro/routes";',
      'export default defineApp().route("/", routes());',
      '',
    ].join('\n')
  );

  try {
    await expect(
      createServer({
        configFile: `${root}/vite.config.ts`,
        root,
        server: { port: 0 },
      })
    ).rejects.toThrow(
      /\[shinro\][\s\S]*server entry[\s\S]*src\/server\.ts[\s\S]*entry:/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});
