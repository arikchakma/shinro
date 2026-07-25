import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { testClient } from 'hono/testing';
import {
  build,
  createLogger,
  createServer,
  createServerModuleRunner,
  resolveConfig,
} from 'vite-plus';
import { expect, expectTypeOf, test } from 'vite-plus/test';

import { createClient } from '../.daroyan/client.ts';
import { daroyan } from '../src/index.ts';
import { affectsRouteTree } from '../src/server/scanner.ts';
import app from './fixtures/basic/src/app.ts';

const client = testClient(app);
const temporaryAppSource = [
  `import { defineApp } from ${JSON.stringify(
    fileURLToPath(new URL('../src/app.ts', import.meta.url))
  )};`,
  'import { routes } from "daroyan/routes";',
  'export default defineApp().route("/", routes());',
  '',
].join('\n');

test('mounting the generated router keeps one Hono instance', () => {
  // `route()` copies the sub-router's routes into the parent and returns the
  // same instance, so file routes land on the app src/app.ts exports rather
  // than on a separate router dispatched to at request time.
  expect(app.routes.map((route) => route.path)).toContain('/health');
  expect(app.routes.map((route) => route.path)).toContain('/manual');
});

test('a GET route is discovered, assembled, and available to the RPC client', async () => {
  const response = await client.health.$get();

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true });
});

test('HEAD uses the matching GET route and omits its response body', async () => {
  const response = await app.request('/health', { method: 'HEAD' });

  expect(response.status).toBe(200);
  await expect(response.text()).resolves.toBe('');
});

test('one route module can expose multiple HTTP methods to runtime and RPC', async () => {
  const response = await client.health.$post();

  expectTypeOf(response.status).toEqualTypeOf<201>();
  expect(response.status).toBe(201);
  await expect(response.json()).resolves.toEqual({ created: true });
});

test('PUT, PATCH, DELETE, and OPTIONS exports reach runtime and RPC', async () => {
  const put = await client.verbs.$put();
  const patch = await client.verbs.$patch();
  const deleted = await client.verbs.$delete();
  const options = await client.verbs.$options();

  expectTypeOf(put.status).toEqualTypeOf<200>();
  expectTypeOf(patch.status).toEqualTypeOf<200>();
  expectTypeOf(deleted.status).toEqualTypeOf<200>();
  expectTypeOf(options.status).toEqualTypeOf<200>();
  await expect(put.json()).resolves.toEqual({ method: 'PUT' });
  await expect(patch.json()).resolves.toEqual({ method: 'PATCH' });
  await expect(deleted.json()).resolves.toEqual({ method: 'DELETE' });
  await expect(options.json()).resolves.toEqual({ method: 'OPTIONS' });
});

test('the app environment types route handlers without a repeated generic', async () => {
  const response = await client.whoami.$get();

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ requestId: 'req_123' });
});

test('chained manual Hono routes remain available on the assembled app', async () => {
  const response = await app.request('/manual');

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ manual: true });
});

test('multiple directory middleware run once in order at the directory and descendants', async () => {
  for (const path of ['/api', '/api/users']) {
    const response = await app.request(path);

    expect(response.headers.get('x-middleware-order')).toBe('first,second');
  }
});

test('ancestor directory middleware stack root-to-leaf', async () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const root = await mkdtemp(`${packageRoot}/.daroyan-middleware-hierarchy-`);
  const helper = JSON.stringify(
    fileURLToPath(new URL('../src/app.ts', import.meta.url))
  );
  await mkdir(`${root}/src/routes/api`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/_middleware.ts`,
    [
      `import { defineMiddleware } from ${helper};`,
      'export default defineMiddleware(async (c, next) => {',
      '  c.set("order", ["root"]);',
      '  await next();',
      '});',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/routes/api/_middleware.ts`,
    [
      `import { defineMiddleware } from ${helper};`,
      'export default defineMiddleware(async (c, next) => {',
      '  c.set("order", [...c.get("order"), "api"]);',
      '  await next();',
      '});',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/routes/index.ts`,
    'export const GET = [(c: any) => c.json({ order: c.get("order") })] as const;\n'
  );
  await writeFile(
    `${root}/src/routes/api/index.ts`,
    'export const GET = [(c: any) => c.json({ order: c.get("order") })] as const;\n'
  );

  const server = await createServer({
    configFile: false,
    customLogger: createLogger('silent'),
    plugins: [daroyan()],
    root,
    server: { middlewareMode: true },
  });

  try {
    const runner = createServerModuleRunner(server.environments.ssr);
    const appModule = (await runner.import(`${root}/src/app.ts`)) as {
      default: { request(path: string): Promise<Response> };
    };

    await expect(
      (await appModule.default.request('/')).json()
    ).resolves.toEqual({
      order: ['root'],
    });
    await expect(
      (await appModule.default.request('/api')).json()
    ).resolves.toEqual({
      order: ['root', 'api'],
    });
  } finally {
    await server.close();
    await rm(root, { recursive: true });
  }
});

test('directory middleware responses are part of the RPC response union', async () => {
  const response = await client.secure.$get();

  expectTypeOf(response.status).toEqualTypeOf<200 | 401>();
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({ error: 'UNAUTHORIZED' });
});

test('a default Hono subrouter runs at its mount and appears on the RPC client', async () => {
  const rootResponse = await client.admin.$get();
  const statsResponse = await client.admin.stats.$get();

  expect(rootResponse.status).toBe(200);
  await expect(rootResponse.json()).resolves.toEqual({ section: 'admin' });
  await expect(statsResponse.json()).resolves.toEqual({ activeUsers: 42 });
});

test('directory middleware surrounds a default sub-router mount exactly once', async () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const root = await mkdtemp(
    `${packageRoot}/.daroyan-subrouter-middleware-runtime-`
  );
  await mkdir(`${root}/src/routes/admin`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/admin/_middleware.ts`,
    [
      `import { defineMiddleware } from ${JSON.stringify(
        fileURLToPath(new URL('../src/app.ts', import.meta.url))
      )};`,
      'export default defineMiddleware(async (c, next) => {',
      '  c.set("middlewareRuns", (c.get("middlewareRuns") ?? 0) + 1);',
      '  await next();',
      '});',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/routes/admin/index.ts`,
    [
      'import { Hono } from "hono";',
      'export default new Hono<any>()',
      '  .get("/", (c) => c.json({ middlewareRuns: c.get("middlewareRuns"), page: "root" }))',
      '  .get("/stats", (c) => c.json({ middlewareRuns: c.get("middlewareRuns"), page: "stats" }));',
      '',
    ].join('\n')
  );

  const server = await createServer({
    configFile: false,
    customLogger: createLogger('silent'),
    plugins: [daroyan()],
    root,
    server: { middlewareMode: true },
  });

  try {
    const runner = createServerModuleRunner(server.environments.ssr);
    const appModule = (await runner.import(`${root}/src/app.ts`)) as {
      default: { request(path: string): Promise<Response> };
    };

    for (const path of ['/admin', '/admin/stats']) {
      const response = await appModule.default.request(path);
      await expect(response.json()).resolves.toMatchObject({
        middlewareRuns: 1,
      });
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true });
  }
});

test('conflicting file routes fail configuration with both source files', async () => {
  const root = fileURLToPath(new URL('./fixtures/conflict', import.meta.url));

  await expect(
    resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
  ).rejects.toThrow(
    /\[daroyan\][\s\S]*\/users[\s\S]*(?:users\.ts[\s\S]*users\/index\.ts|users\/index\.ts[\s\S]*users\.ts)/
  );
});

test('equivalent dynamic route shapes conflict even when parameter names differ', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-dynamic-shape-conflict-`);

  await mkdir(`${root}/src/routes/users`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/users/$id.ts`,
    "export const GET = [(c: any) => c.json({ id: c.req.param('id') })] as const;\n"
  );
  await writeFile(
    `${root}/src/routes/users/$slug.ts`,
    "export const GET = [(c: any) => c.json({ slug: c.req.param('slug') })] as const;\n"
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*\/users\/:id[\s\S]*(?:\$id\.ts[\s\S]*\$slug\.ts|\$slug\.ts[\s\S]*\$id\.ts)/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a default sub-router reports ownership of its descendant namespace', async () => {
  const root = await mkdtemp(
    `${tmpdir()}/daroyan-subrouter-namespace-conflict-`
  );
  await mkdir(`${root}/src/routes/admin`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/admin.ts`,
    [
      'import { Hono } from "hono";',
      'export default new Hono().get("/", (c) => c.json({ admin: true }));',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/routes/admin/stats.ts`,
    'export const GET = [(c: any) => c.json({ active: 1 })] as const;\n'
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*\/admin[\s\S]*admin\.ts[\s\S]*admin\/stats\.ts[\s\S]*owns[\s\S]*namespace/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a default sub-router namespace rejects dynamically matching descendants', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-dynamic-namespace-conflict-`);
  await mkdir(`${root}/src/routes/$section`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/admin.ts`,
    [
      'import { Hono } from "hono";',
      'export default new Hono().get("/stats", (c) => c.json({ admin: true }));',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/routes/$section/stats.ts`,
    "export const GET = [(c: any) => c.json({ section: c.req.param('section') })] as const;\n"
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*namespace conflict[\s\S]*\/admin[\s\S]*(?:admin\.ts[\s\S]*\$section\/stats\.ts|\$section\/stats\.ts[\s\S]*admin\.ts)/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('the generated client exposes the assembled application contract', () => {
  const generatedClient = createClient('http://localhost');

  expectTypeOf(generatedClient.health.$get).toBeFunction();
  expectTypeOf(generatedClient.manual.$get).toBeFunction();
  expectTypeOf(generatedClient.admin.stats.$get).toBeFunction();
});

test('a package that exposes generated RPC warns when its client export is missing', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-client-export-warning-`);
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/package.json`,
    JSON.stringify({
      name: '@example/api',
      exports: {
        './rpc': './.daroyan/rpc.ts',
      },
    })
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      'serve'
    );

    expect(warnings.join('\n')).toMatch(
      /\[daroyan\][\s\S]*package\.json[\s\S]*generated client[\s\S]*\.\/client[\s\S]*\.daroyan\/client\.ts/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('generation writes a project-relative normalized manifest', async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL('../.daroyan/manifest.json', import.meta.url),
      'utf8'
    )
  ) as {
    routes: Array<{
      file: string;
      kind: string;
      methods?: string[];
      mountPath?: string;
      path?: string;
    }>;
    version: number;
  };

  expect(manifest.version).toBe(2);
  expect(manifest.routes).toContainEqual({
    file: 'tests/fixtures/basic/src/routes/health.ts',
    kind: 'methods',
    methods: ['GET', 'POST'],
    middleware: [],
    path: '/health',
  });
  expect(manifest.routes).toContainEqual({
    file: 'tests/fixtures/basic/src/routes/admin.ts',
    kind: 'sub-router',
    middleware: [],
    mountPath: '/admin',
  });
});

test('an optional route companion provides exact filename parameter types', async () => {
  const response = await client.api.users[':id'].$get({
    param: { id: 'usr_123' },
  });

  // @ts-expect-error Pending the strict companion API decision: an explicit
  // Route generic currently widens the handler response status.
  expectTypeOf(response.status).toEqualTypeOf<200>();
  await expect(response.json()).resolves.toEqual({ id: 'usr_123' });
});

test('a route companion exposes its contract through Route.Handler', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-route-handler-companion-`);

  await mkdir(`${root}/src/routes/users`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/users/$id.ts`,
    "export const GET = [(c: any) => c.json({ id: c.req.param('id') })] as const;\n"
  );

  try {
    await resolveConfig(
      { configFile: false, plugins: [daroyan()], root },
      'serve'
    );
    const source = await readFile(
      `${root}/.daroyan/types/src/routes/users/+types/$id.d.ts`,
      'utf8'
    );

    expect(source).toMatch(
      /export namespace Route \{[\s\S]*export type Handler = DaroyanRoute<\{[\s\S]*path: "\/users\/:id"/
    );
    expect(source).not.toMatch(/export type Route\s*=/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('route companions are generated correctly when the project path contains spaces', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan route types `);
  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/health.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  try {
    await resolveConfig(
      { configFile: false, plugins: [daroyan()], root },
      'serve'
    );

    await expect(
      readFile(`${root}/.daroyan/types/src/routes/+types/health.d.ts`, 'utf8')
    ).resolves.toContain('path: "/health"');
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a route handler accepts route-local middleware', async () => {
  const response = await client.local.$get();

  await expect(response.json()).resolves.toEqual({ requestId: 'req_local' });
});

test('unchanged generated files retain their modification time', async () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const fixtureRoot = fileURLToPath(
    new URL('./fixtures/basic', import.meta.url)
  );
  const rpcFile = new URL('../.daroyan/rpc.ts', import.meta.url);
  const unchangedTime = new Date('2020-01-02T03:04:05.000Z');

  await utimes(rpcFile, unchangedTime, unchangedTime);
  await resolveConfig(
    {
      configFile: false,
      plugins: [
        daroyan({
          app: `${fixtureRoot}/src/app.ts`,
          routes: `${fixtureRoot}/src/routes`,
        }),
      ],
      root: packageRoot,
    },
    'serve'
  );

  expect((await stat(rpcFile)).mtimeMs).toBe(unchangedTime.getTime());
});

test('a generation write failure leaves the previous RPC contract intact', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-generation-transaction-`);
  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/health.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  try {
    await resolveConfig(
      { configFile: false, plugins: [daroyan()], root },
      'serve'
    );
    const previousManifest = await readFile(
      `${root}/.daroyan/manifest.json`,
      'utf8'
    );
    const previousRpc = await readFile(`${root}/.daroyan/rpc.ts`, 'utf8');

    await writeFile(
      `${root}/src/routes/api.ts`,
      'export const GET = [(c: any) => c.json({ api: true })] as const;\n'
    );
    await mkdir(`${root}/.daroyan/types/src/routes/+types/api.d.ts`, {
      recursive: true,
    });

    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow();

    await expect(
      readFile(`${root}/.daroyan/manifest.json`, 'utf8')
    ).resolves.toBe(previousManifest);
    await expect(readFile(`${root}/.daroyan/rpc.ts`, 'utf8')).resolves.toBe(
      previousRpc
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('generated artifacts identify their format and warn against editing', async () => {
  const rpc = await readFile(
    new URL('../.daroyan/rpc.ts', import.meta.url),
    'utf8'
  );
  const manifest = await readFile(
    new URL('../.daroyan/manifest.json', import.meta.url),
    'utf8'
  );

  expect(rpc).toMatch(
    /^\/\/ Generated by Daroyan \(format 2\)\. Do not edit\./
  );
  expect(manifest).toMatch(
    /^\{\n  "_notice": "Generated by Daroyan \(format 2\)\. Do not edit\."/
  );
});

test('basePath prefixes normalized runtime and RPC routes', async () => {
  const root = fileURLToPath(new URL('./fixtures/basepath', import.meta.url));

  await resolveConfig(
    { configFile: false, plugins: [daroyan({ basePath: '/v1/' })], root },
    'serve'
  );
  const manifest = JSON.parse(
    await readFile(
      new URL('./fixtures/basepath/.daroyan/manifest.json', import.meta.url),
      'utf8'
    )
  ) as { basePath: string; routes: Array<{ path: string }> };

  expect(manifest.basePath).toBe('/v1');
  expect(manifest.routes[0]?.path).toBe('/v1/health');
});

test('rpc.outDir refuses a directory holding files Daroyan did not generate', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-outdir-guard-`);

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);

  try {
    await expect(
      resolveConfig(
        {
          configFile: false,
          plugins: [daroyan({ rpc: { outDir: 'src' } })],
          root,
        },
        'serve'
      )
    ).rejects.toThrow(/\[daroyan\][\s\S]*Refusing to generate[\s\S]*app\.ts/i);

    // The source directory must survive the rejected configuration untouched.
    await expect(readFile(`${root}/src/app.ts`, 'utf8')).resolves.toBe(
      temporaryAppSource
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a partially generated directory is still recognised as Daroyan output', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-partial-outdir-`);

  await mkdir(`${root}/src/routes`, { recursive: true });
  await mkdir(`${root}/.daroyan`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/health.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );
  // Everything a concurrent generation writes before the manifest marker.
  await writeFile(`${root}/.daroyan/daroyan.d.ts`, '');
  await writeFile(`${root}/.daroyan/routes.ts`, '');

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).resolves.toBeDefined();
  } finally {
    await rm(root, { recursive: true });
  }
});

test('ALL serves every verb and yields to an explicit method export', async () => {
  // Inside the package, not the OS temp directory: the generated router imports
  // `hono`, so it only resolves where a node_modules tree is reachable.
  const root = await mkdtemp(
    fileURLToPath(new URL('../.daroyan-all-method-', import.meta.url))
  );

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/thing.ts`,
    [
      'export const GET = [(c: any) => c.json({ handler: "get" })] as const;',
      'export const ALL = [(c: any) => c.json({ handler: "all" })] as const;',
      '',
    ].join('\n')
  );

  const server = await createServer({
    configFile: false,
    plugins: [daroyan()],
    root,
    server: { middlewareMode: true },
  });

  try {
    const runner = createServerModuleRunner(server.environments.ssr);
    const appModule = (await runner.import(`${root}/src/app.ts`)) as {
      default: {
        request: (path: string, init?: RequestInit) => Promise<Response>;
      };
    };
    const app = appModule.default;

    await expect(
      (await app.request('/thing', { method: 'GET' })).json()
    ).resolves.toEqual({ handler: 'get' });
    await expect(
      (await app.request('/thing', { method: 'POST' })).json()
    ).resolves.toEqual({ handler: 'all' });
    await expect(
      (await app.request('/thing', { method: 'DELETE' })).json()
    ).resolves.toEqual({ handler: 'all' });
  } finally {
    await server.close();
    await rm(root, { recursive: true });
  }
}, 15_000);

test('a lock left by a dead process is reclaimed instead of timing out', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-stale-lock-`);

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/health.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  // Reap a real process so its pid is genuinely gone rather than guessed.
  const dead = spawn(process.execPath, ['--eval', '']);
  await once(dead, 'exit');
  await mkdir(`${root}/.daroyan`, { recursive: true });
  await writeFile(`${root}/.daroyan/.lock`, `${dead.pid}\n`);

  try {
    const startedAt = Date.now();
    await resolveConfig(
      { configFile: false, plugins: [daroyan()], root },
      'serve'
    );

    expect(Date.now() - startedAt).toBeLessThan(10_000);
    await expect(
      readFile(`${root}/.daroyan/routes.ts`, 'utf8')
    ).resolves.toContain('.get("/health"');
    await expect(
      readFile(`${root}/.daroyan/.lock`, 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true });
  }
}, 40_000);

test('the development child leaves generation and diagnostics to its parent', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-dev-child-`);
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/health.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  process.env.DAROYAN_DEV_CHILD = '1';
  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      'serve'
    );

    await expect(
      readFile(`${root}/.daroyan/routes.ts`, 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(warnings).toEqual([]);
  } finally {
    delete process.env.DAROYAN_DEV_CHILD;
    await rm(root, { recursive: true });
  }
});

test('basePath collapses repeated separators instead of emptying a segment', async () => {
  const root = fileURLToPath(new URL('./fixtures/basepath', import.meta.url));

  await resolveConfig(
    {
      configFile: false,
      plugins: [daroyan({ basePath: '//v1//api//' })],
      root,
    },
    'serve'
  );
  const manifest = JSON.parse(
    await readFile(
      new URL('./fixtures/basepath/.daroyan/manifest.json', import.meta.url),
      'utf8'
    )
  ) as { basePath: string; routes: Array<{ path: string }> };

  expect(manifest.basePath).toBe('/v1/api');
  expect(manifest.routes[0]?.path).toBe('/v1/api/health');
});

test('an invalid basePath fails with the Daroyan option name', async () => {
  const root = fileURLToPath(new URL('./fixtures/basepath', import.meta.url));

  await expect(
    resolveConfig(
      {
        configFile: false,
        plugins: [daroyan({ basePath: 'api' as '/api' })],
        root,
      },
      'serve'
    )
  ).rejects.toThrow(/\[daroyan\][\s\S]*basePath[\s\S]*start[\s\S]*\//i);
});

test('defineHandler preserves an arbitrary route-local middleware tuple', async () => {
  const response = await client.pipeline.$get();

  expect(response.headers.get('x-pipeline-first')).toBe('yes');
  expect(response.headers.get('x-pipeline-second')).toBe('yes');
  await expect(response.json()).resolves.toEqual({ complete: true });
});

test('the plugin configures the user-owned server as the production build entry', async () => {
  const root = fileURLToPath(new URL('./fixtures/basepath', import.meta.url));
  const config = await resolveConfig(
    {
      configFile: false,
      plugins: [
        daroyan({
          build: {
            fileName: 'api.mjs',
            minify: true,
            outDir: 'output',
            sourcemap: 'inline',
          },
          entry: 'src/server.ts',
        }),
      ],
      root,
    },
    'build'
  );

  expect(config.build.outDir).toBe('output');
  expect(config.build.sourcemap).toBe('inline');
  expect(config.build.minify).toBe('oxc');
  expect(config.build.ssr).toBe(`${root}/src/server.ts`);
});

test('zValidator provides runtime and RPC parameter validation without Route', async () => {
  const validResponse = await client.validated[':id'].$get({
    param: { id: 'usr_123' },
  });
  const invalidResponse = await client.validated[':id'].$get({
    param: { id: 'x' },
  });

  expectTypeOf(invalidResponse.status).toEqualTypeOf<200 | 400>();
  await expect(validResponse.json()).resolves.toEqual({ id: 'usr_123' });
  expect(invalidResponse.status).toBe(400);
});

test('test files are excluded from route discovery', async () => {
  const response = await app.request('/ignored.spec.route');

  expect(response.status).toBe(404);
});

test('reserved basenames and directories are excluded from route discovery', async () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const root = await mkdtemp(`${packageRoot}/.daroyan-ignored-routes-`);
  const ignoredFiles = [
    'src/routes/_private.ts',
    'src/routes/.hidden.ts',
    'src/routes/types.d.ts',
    'src/routes/unit.test.ts',
    'src/routes/behavior.spec.js',
    'src/routes/__tests__/route.ts',
    'src/routes/__fixtures__/route.ts',
    'src/routes/+types/route.ts',
    'src/routes/.generated/route.ts',
  ];

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/visible.ts`,
    'export const GET = [(c: any) => c.json({ visible: true })] as const;\n'
  );
  for (const file of ignoredFiles) {
    await mkdir(`${root}/${file.slice(0, file.lastIndexOf('/'))}`, {
      recursive: true,
    });
    await writeFile(
      `${root}/${file}`,
      'export const GET = [(c: any) => c.json({ ignored: true })] as const;\n'
    );
  }

  const server = await createServer({
    configFile: false,
    customLogger: createLogger('silent'),
    plugins: [daroyan()],
    root,
    server: { middlewareMode: true },
  });

  try {
    const runner = createServerModuleRunner(server.environments.ssr);
    const appModule = (await runner.import(`${root}/src/app.ts`)) as {
      default: { request(path: string): Promise<Response> };
    };

    expect((await appModule.default.request('/visible')).status).toBe(200);
    for (const path of [
      '/_private',
      '/.hidden',
      '/types.d',
      '/unit.test',
      '/behavior.spec',
      '/__tests__/route',
      '/__fixtures__/route',
      '/+types/route',
      '/.generated/route',
    ]) {
      expect((await appModule.default.request(path)).status).toBe(404);
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true });
  }
});

test('ignoredRouteFiles excludes route-relative minimatch globs', async () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const root = await mkdtemp(`${packageRoot}/.daroyan-custom-ignored-routes-`);

  await mkdir(`${root}/src/routes/internal`, { recursive: true });
  await mkdir(`${root}/src/routes/public`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/internal/_middleware.ts`,
    "throw new Error('ignored middleware must not be loaded');\n"
  );
  await writeFile(
    `${root}/src/routes/internal/health.ts`,
    'export const GET = [(c: any) => c.json({ internal: true })] as const;\n'
  );
  await writeFile(
    `${root}/src/routes/public/health.ts`,
    'export const GET = [(c: any) => c.json({ public: true })] as const;\n'
  );

  const server = await createServer({
    configFile: false,
    customLogger: createLogger('silent'),
    plugins: [daroyan({ ignoredRouteFiles: ['internal/**'] })],
    root,
    server: { middlewareMode: true },
  });

  try {
    const runner = createServerModuleRunner(server.environments.ssr);
    const appModule = (await runner.import(`${root}/src/app.ts`)) as {
      default: { request(path: string): Promise<Response> };
    };

    expect((await appModule.default.request('/internal/health')).status).toBe(
      404
    );
    expect((await appModule.default.request('/public/health')).status).toBe(
      200
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true });
  }
});

test('a catch-all route captures one or more path segments', async () => {
  const response = await app.request('/files/reports/2026/july');
  const emptyResponse = await app.request('/files');

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ path: 'reports/2026/july' });
  expect(emptyResponse.status).toBe(404);
});

test('nested dynamic directories and files contribute typed route parameters', async () => {
  const response = await client.teams[':teamId'].members[':memberId'].$get({
    param: {
      memberId: 'mem_456',
      teamId: 'team_123',
    },
  });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    memberId: 'mem_456',
    teamId: 'team_123',
  });
});

test('rpc.outDir relocates all generated artifacts', async () => {
  const root = fileURLToPath(new URL('./fixtures/basepath', import.meta.url));

  await resolveConfig(
    {
      configFile: false,
      plugins: [daroyan({ rpc: { outDir: '.generated' } })],
      root,
    },
    'serve'
  );

  const manifest = await readFile(
    new URL('./fixtures/basepath/.generated/manifest.json', import.meta.url),
    'utf8'
  );
  expect(JSON.parse(manifest)).toMatchObject({ version: 2 });
  await rm(new URL('./fixtures/basepath/.generated', import.meta.url), {
    recursive: true,
  });
});

test('rpc.outDir cannot target the project root', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-root-output-`);
  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/index.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  try {
    await expect(
      resolveConfig(
        {
          configFile: false,
          plugins: [daroyan({ rpc: { outDir: '.' } })],
          root,
        },
        'serve'
      )
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*rpc\.outDir[\s\S]*project root[\s\S]*(?:generated|directory)/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('one TypeScript project cannot install multiple Daroyan applications', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-multiple-apps-`);

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/index.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  try {
    await expect(
      resolveConfig(
        {
          configFile: false,
          plugins: [daroyan(), daroyan()],
          root,
        },
        'serve'
      )
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*(?:one|multiple)[\s\S]*(?:application|plugin)[\s\S]*TypeScript project/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('adding a route during development regenerates every route-derived artifact', async () => {
  const root = await mkdtemp(
    fileURLToPath(new URL('../.daroyan-route-add-', import.meta.url))
  );
  const routesDirectory = `${root}/src/routes`;
  const routeFile = `${routesDirectory}/notes.ts`;
  const manifestFile = `${root}/.daroyan/manifest.json`;
  const routesFile = `${root}/.daroyan/routes.ts`;
  const companionFile = `${root}/.daroyan/types/src/routes/+types/notes.d.ts`;

  await mkdir(routesDirectory, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);

  const server = await createServer({
    configFile: false,
    plugins: [daroyan()],
    root,
    server: { middlewareMode: true },
  });

  try {
    await expect
      .poll(() => Object.keys(server.watcher.getWatched()))
      .toContain(routesDirectory);
    await writeFile(
      routeFile,
      'export const GET = [(c: any) => c.json({ resource: "notes" })] as const;\n'
    );

    await expect
      .poll(
        async () => {
          const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as {
            routes: Array<{ path: string }>;
          };
          return manifest.routes.map((route) => route.path);
        },
        { timeout: 5_000 }
      )
      .toContain('/notes');

    await expect(readFile(routesFile, 'utf8')).resolves.toContain(
      '.get("/notes"'
    );
    await expect(readFile(companionFile, 'utf8')).resolves.toContain(
      'path: "/notes"'
    );
    await expect(
      server.transformRequest('daroyan/routes')
    ).resolves.toMatchObject({
      code: expect.stringContaining('.get("/notes"'),
    });
  } finally {
    await server.close();
    await rm(root, { recursive: true });
  }
}, 15_000);

test('only route-tree files are treated as regeneration triggers', () => {
  const routes = '/project/src/routes';
  const affects = (file: string, ignored?: string[]) =>
    affectsRouteTree(routes, `${routes}/${file}`, ignored);

  expect(affects('health.ts')).toBe(true);
  expect(affects('users/$id.ts')).toBe(true);
  expect(affects('users/index.js')).toBe(true);
  expect(affects('_middleware.ts')).toBe(true);
  expect(affects('users/_middleware.js')).toBe(true);

  expect(affects('README.md')).toBe(false);
  expect(affects('health.test.ts')).toBe(false);
  expect(affects('health.spec.ts')).toBe(false);
  expect(affects('types.d.ts')).toBe(false);
  expect(affects('_helper.ts')).toBe(false);
  expect(affects('__tests__/health.ts')).toBe(false);
  expect(affects('+types/health.d.ts')).toBe(false);
  expect(affects('internal/secret.ts', ['internal/**'])).toBe(false);
  // An ignore pattern hides directory middleware as well as route modules.
  expect(affects('internal/_middleware.ts', ['internal/**'])).toBe(false);
});

test('removing a route during development deletes its stale companion and registrations', async () => {
  const root = await mkdtemp(
    fileURLToPath(new URL('../.daroyan-route-remove-', import.meta.url))
  );
  const routesDirectory = `${root}/src/routes`;
  const routeFile = `${routesDirectory}/notes.ts`;
  const manifestFile = `${root}/.daroyan/manifest.json`;
  const routesFile = `${root}/.daroyan/routes.ts`;
  const companionFile = `${root}/.daroyan/types/src/routes/+types/notes.d.ts`;

  await mkdir(routesDirectory, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    routeFile,
    'export const GET = [(c: any) => c.json({ resource: "notes" })] as const;\n'
  );

  const server = await createServer({
    configFile: false,
    plugins: [daroyan()],
    root,
    server: { middlewareMode: true },
  });

  try {
    await expect(readFile(companionFile, 'utf8')).resolves.toContain(
      'path: "/notes"'
    );
    await expect
      .poll(() =>
        Object.values(server.watcher.getWatched())
          .flat()
          .some((file) => file === 'notes.ts')
      )
      .toBe(true);
    await rm(routeFile);

    await expect
      .poll(
        async () => {
          const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as {
            routes: Array<{ path: string }>;
          };
          return manifest.routes.map((route) => route.path);
        },
        { timeout: 5_000 }
      )
      .not.toContain('/notes');

    await expect(readFile(routesFile, 'utf8')).resolves.not.toContain(
      '.get("/notes"'
    );
    await expect(readFile(companionFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      server.transformRequest('daroyan/routes')
    ).resolves.toMatchObject({
      code: expect.not.stringContaining('.get("/notes"'),
    });
  } finally {
    await server.close();
    await rm(root, { recursive: true });
  }
}, 15_000);

test('routes register in static, dynamic, then catch-all priority', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-route-order-`);
  const routesDirectory = `${root}/src/routes/items`;

  await mkdir(routesDirectory, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  for (const file of ['$id.ts', '$...path.ts', 'all.ts']) {
    await writeFile(
      `${routesDirectory}/${file}`,
      'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
    );
  }

  try {
    await resolveConfig(
      { configFile: false, plugins: [daroyan()], root },
      'serve'
    );
    const manifest = JSON.parse(
      await readFile(`${root}/.daroyan/manifest.json`, 'utf8')
    ) as {
      routes: Array<{ path: string }>;
    };

    expect(manifest.routes.map((route) => route.path)).toEqual([
      '/items/all',
      '/items/:id',
      '/items/:path{.+}',
    ]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a catch-all segment before the end of a route fails with its source file', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-invalid-catch-all-`);
  const routesDirectory = `${root}/src/routes/files/$...path`;

  await mkdir(routesDirectory, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${routesDirectory}/edit.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow(
      /src\/routes\/files\/\$\.\.\.path\/edit\.ts[\s\S]*catch-all[\s\S]*final/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('an invalid dynamic parameter name fails with its source file and parameter', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-invalid-parameter-`);
  const routesDirectory = `${root}/src/routes/users`;

  await mkdir(routesDirectory, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${routesDirectory}/$bad-name.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow(
      /src\/routes\/users\/\$bad-name\.ts[\s\S]*invalid dynamic parameter name[\s\S]*bad-name/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('duplicate dynamic parameter names in one route fail before generation', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-duplicate-route-parameter-`);

  await mkdir(`${root}/src/routes/teams/$id/members`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/teams/$id/members/$id.ts`,
    "export const GET = [(c: any) => c.json({ id: c.req.param('id') })] as const;\n"
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*teams\/\$id\/members\/\$id\.ts[\s\S]*duplicate[\s\S]*parameter[\s\S]*"id"/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a route cannot mix a default sub-router with named method exports', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-mixed-route-`);
  const routesDirectory = `${root}/src/routes`;
  const routeFile = `${routesDirectory}/admin.ts`;

  await mkdir(routesDirectory, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    routeFile,
    [
      'import { Hono } from "hono";',
      'export const GET = [(c: any) => c.json({ ok: true })] as const;',
      'export default new Hono();',
      '',
    ].join('\n')
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow(
      /src\/routes\/admin\.ts[\s\S]*cannot mix[\s\S]*default[\s\S]*GET/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a named method exported through an export list is discovered', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-export-list-`);
  const routesDirectory = `${root}/src/routes`;

  await mkdir(routesDirectory, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${routesDirectory}/health.ts`,
    [
      'const GET = [(c: any) => c.json({ ok: true })] as const;',
      'export { GET };',
      '',
    ].join('\n')
  );

  try {
    await resolveConfig(
      { configFile: false, plugins: [daroyan()], root },
      'serve'
    );
    const manifest = JSON.parse(
      await readFile(`${root}/.daroyan/manifest.json`, 'utf8')
    ) as {
      routes: Array<{ methods: string[]; path: string }>;
    };

    expect(manifest.routes).toContainEqual(
      expect.objectContaining({ methods: ['GET'], path: '/health' })
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('directory middleware receives an optional generated companion type', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-middleware-companion-`);
  const helper = JSON.stringify(
    fileURLToPath(new URL('../src/app.ts', import.meta.url))
  );

  await mkdir(`${root}/src/routes/api`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/api/_middleware.ts`,
    [
      `import { defineMiddleware } from ${helper};`,
      'export default defineMiddleware(',
      '  async (_c, next) => { await next(); },',
      '  async (_c, next) => { await next(); },',
      ');',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/routes/api/index.ts`,
    "export const GET = [(c: any) => c.text('ok')] as const;\n"
  );

  try {
    await resolveConfig(
      { configFile: false, plugins: [daroyan()], root },
      'serve'
    );
    const source = await readFile(
      `${root}/.daroyan/types/src/routes/api/+types/_middleware.d.ts`,
      'utf8'
    );

    expect(source).toMatch(
      /export namespace Route \{[\s\S]*export type Middleware = DaroyanMiddleware<\{[\s\S]*path: "\/api"/
    );
    expect(source).not.toMatch(/^export type Middleware\s*=/m);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a production build fails when it emits more than one JavaScript chunk', async () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const root = await mkdtemp(`${packageRoot}/.daroyan-split-build-`);

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/health.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );
  await writeFile(`${root}/src/lazy.ts`, 'export const value = 42;\n');
  await writeFile(
    `${root}/src/server.ts`,
    [
      'import app from "./app.ts";',
      'export const lazy = import("./lazy.ts");',
      'export default app;',
      '',
    ].join('\n')
  );

  try {
    await expect(
      build({
        configFile: false,
        logLevel: 'silent',
        plugins: [daroyan({ build: { unbundle: false } })],
        root,
      })
    ).rejects.toThrow(
      /daroyan[\s\S]*multiple javascript chunks[\s\S]*single entry/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('the default build keeps the server entry but preserves the source module tree', async () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const root = await mkdtemp(`${packageRoot}/.daroyan-unbundle-`);

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/health.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );
  await writeFile(`${root}/src/lazy.ts`, 'export const value = 42;\n');
  await writeFile(
    `${root}/src/server.ts`,
    [
      'import app from "./app.ts";',
      'export const lazy = import("./lazy.ts");',
      'export default app;',
      '',
    ].join('\n')
  );

  try {
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [daroyan()],
      root,
    });
    const outputs = Array.isArray(result) ? result : [result];
    const chunks = outputs
      .flatMap((output) => ('output' in output ? output.output : []))
      .filter((chunk) => chunk.type === 'chunk');
    const entryChunks = chunks.filter((chunk) => chunk.isEntry);

    // A dynamic import that would fail the single-artifact build is allowed here.
    expect(chunks.length).toBeGreaterThan(1);
    expect(entryChunks).toHaveLength(1);
    expect(entryChunks[0]?.fileName).toBe('server.mjs');
    expect(chunks.map((chunk) => chunk.fileName)).toContain('lazy.mjs');
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a production build warns when it emits an external runtime asset', async () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const root = await mkdtemp(`${packageRoot}/.daroyan-external-asset-`);
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/index.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );
  await writeFile(`${root}/src/runtime.txt`, 'runtime asset\n'.repeat(100));
  await writeFile(
    `${root}/src/server.ts`,
    [
      'import runtimeAsset from "./runtime.txt?url";',
      'import app from "./app.ts";',
      'console.log(runtimeAsset);',
      'export default app;',
      '',
    ].join('\n')
  );

  try {
    await build({
      build: { assetsInlineLimit: 0 },
      configFile: false,
      customLogger: logger,
      plugins: [daroyan({ build: { unbundle: false } })],
      root,
    });

    expect(warnings.join('\n')).toMatch(
      /\[daroyan\][\s\S]*external runtime asset[\s\S]*one-entry/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a production build rejects an unexpected server entry filename', async () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const root = await mkdtemp(`${packageRoot}/.daroyan-entry-filename-`);

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/index.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );
  await writeFile(
    `${root}/src/server.ts`,
    'import app from "./app.ts";\nexport default app;\n'
  );

  try {
    await expect(
      build({
        configFile: false,
        logLevel: 'silent',
        plugins: [
          daroyan({ build: { unbundle: false } }),
          {
            name: 'override-daroyan-entry-filename',
            config: () => ({
              build: {
                rolldownOptions: {
                  output: { entryFileNames: 'unexpected.mjs' },
                },
              },
            }),
          },
        ],
        root,
      })
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*unexpected\.mjs[\s\S]*server\.mjs[\s\S]*entry filename/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('rpc.enabled false keeps routing typegen but omits RPC client artifacts', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-rpc-disabled-`);

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/health.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  try {
    await resolveConfig(
      {
        configFile: false,
        plugins: [daroyan({ rpc: { enabled: false } })],
        root,
      },
      'serve'
    );

    await expect(
      readFile(`${root}/.daroyan/manifest.json`, 'utf8')
    ).resolves.toContain('"/health"');
    await expect(
      readFile(`${root}/.daroyan/types/src/routes/+types/health.d.ts`, 'utf8')
    ).resolves.toContain('path: "/health"');
    await expect(
      readFile(`${root}/.daroyan/rpc.ts`, 'utf8')
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      readFile(`${root}/.daroyan/client.ts`, 'utf8')
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });

    // Routing is not an RPC feature: the router the app mounts, and the
    // declaration that gives `daroyan/routes` its type, are both still there.
    await expect(
      readFile(`${root}/.daroyan/routes.ts`, 'utf8')
    ).resolves.toContain('.get("/health"');
    const modules = await readFile(`${root}/.daroyan/daroyan.d.ts`, 'utf8');
    expect(modules).toContain('declare module "daroyan/routes"');
    expect(modules).not.toContain('declare module "daroyan/client"');
  } finally {
    await rm(root, { recursive: true });
  }
});

test('an app that never mounts the generated router warns with the route count', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-missing-mount-`);
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(
    `${root}/src/app.ts`,
    `import { defineApp } from ${JSON.stringify(
      fileURLToPath(new URL('../src/app.ts', import.meta.url))
    )};\nexport default defineApp();\n`
  );
  await writeFile(
    `${root}/src/routes/health.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      'serve'
    );

    // Nothing throws — the app is valid Hono, it just serves no file routes.
    // Silence would leave the user with an empty router and no explanation.
    expect(warnings.join('\n')).toMatch(
      /\[daroyan\][\s\S]*src\/app\.ts[\s\S]*daroyan\/routes[\s\S]*1[\s\S]*\.route\("\/", routes\(\)\)/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('an app that mounts the generated router is not warned about', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-mounted-`);
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/health.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      'serve'
    );

    expect(warnings.join('\n')).not.toMatch(/never mounts/i);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('an app with no file routes is not asked to mount anything', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-no-routes-no-mount-`);
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(
    `${root}/src/app.ts`,
    `import { defineApp } from ${JSON.stringify(
      fileURLToPath(new URL('../src/app.ts', import.meta.url))
    )};\nexport default defineApp();\n`
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      'serve'
    );

    expect(warnings.join('\n')).not.toMatch(/never mounts/i);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('middleware chained after the mount warns about registration order', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-mount-order-chained-`);
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(
    `${root}/src/app.ts`,
    [
      `import { defineApp } from ${JSON.stringify(
        fileURLToPath(new URL('../src/app.ts', import.meta.url))
      )};`,
      'import { routes } from "daroyan/routes";',
      'export default defineApp()',
      '  .route("/", routes())',
      '  .use("*", async (_c, next) => { await next(); });',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/routes/health.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      'serve'
    );

    expect(warnings.join('\n')).toMatch(
      /\[daroyan\][\s\S]*src\/app\.ts[\s\S]*registration order[\s\S]*file route/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a middleware statement after the mount warns about registration order', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-mount-order-statement-`);
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(
    `${root}/src/app.ts`,
    [
      `import { defineApp } from ${JSON.stringify(
        fileURLToPath(new URL('../src/app.ts', import.meta.url))
      )};`,
      'import { routes } from "daroyan/routes";',
      'const app = defineApp().route("/", routes());',
      'app.use("*", async (_c, next) => { await next(); });',
      'export default app;',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/routes/health.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      'serve'
    );

    expect(warnings.join('\n')).toMatch(
      /\[daroyan\][\s\S]*src\/app\.ts[\s\S]*registration order[\s\S]*file route/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('middleware registered before the mount is not warned about', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-mount-order-correct-`);
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(
    `${root}/src/app.ts`,
    [
      `import { defineApp } from ${JSON.stringify(
        fileURLToPath(new URL('../src/app.ts', import.meta.url))
      )};`,
      'import { routes } from "daroyan/routes";',
      'export default defineApp()',
      '  .use("*", async (_c, next) => { await next(); })',
      '  .route("/", routes());',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/routes/health.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      'serve'
    );

    expect(warnings.join('\n')).not.toMatch(/registration order/i);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('generating over an older project removes its entry artifacts', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-legacy-cleanup-`);

  await mkdir(`${root}/src/routes`, { recursive: true });
  await mkdir(`${root}/.daroyan`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/health.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );
  // `.daroyan` is gitignored, so every existing project starts generation with
  // the previous format's files still on disk. A stale `modules.d.ts` is not
  // inert: it declares `daroyan/entry` against an `entry.ts` that still imports
  // the app and registers an outdated route table.
  await writeFile(
    `${root}/.daroyan/entry.ts`,
    '// Generated by Daroyan (format 1). Do not edit.\nexport default {};\n'
  );
  await writeFile(
    `${root}/.daroyan/modules.d.ts`,
    '// Generated by Daroyan (format 1). Do not edit.\ndeclare module "daroyan/entry" {}\n'
  );

  try {
    await resolveConfig(
      { configFile: false, plugins: [daroyan()], root },
      'serve'
    );

    for (const file of ['entry.ts', 'modules.d.ts']) {
      await expect(
        readFile(`${root}/.daroyan/${file}`, 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(
      readFile(`${root}/.daroyan/routes.ts`, 'utf8')
    ).resolves.toContain('.get("/health"');
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a hand-written file the previous format never generated is left alone', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-legacy-handwritten-`);

  await mkdir(`${root}/src/routes`, { recursive: true });
  await mkdir(`${root}/.daroyan`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  // No generated notice, so removal must refuse to touch it even though the
  // name is one Daroyan used to own.
  await writeFile(`${root}/.daroyan/entry.ts`, 'export const mine = true;\n');

  try {
    await resolveConfig(
      { configFile: false, plugins: [daroyan()], root },
      'serve'
    );

    await expect(
      readFile(`${root}/.daroyan/entry.ts`, 'utf8')
    ).resolves.toContain('export const mine = true;');
  } finally {
    await rm(root, { recursive: true });
  }
});

test('every specifier the generated declarations name is importable', async () => {
  const root = await mkdtemp(
    fileURLToPath(new URL('../.daroyan-specifiers-', import.meta.url))
  );

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/health.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  const server = await createServer({
    configFile: false,
    customLogger: createLogger('silent'),
    plugins: [daroyan()],
    root,
    server: { middlewareMode: true },
  });

  try {
    const declarations = await readFile(
      `${root}/.daroyan/daroyan.d.ts`,
      'utf8'
    );
    const declared = [
      ...declarations.matchAll(/declare module "(daroyan\/[^"]+)"/g),
    ].map((match) => match[1]);

    expect(declared).toEqual([
      'daroyan/routes',
      'daroyan/client',
      'daroyan/rpc',
    ]);

    const runner = createServerModuleRunner(server.environments.ssr);
    // A declaration that resolves for TypeScript but not for the bundler is a
    // lie the user only discovers at runtime, so each one is really imported.
    const routesModule = (await runner.import('daroyan/routes')) as {
      routes: unknown;
    };
    const clientModule = (await runner.import('daroyan/client')) as {
      createClient: unknown;
    };

    expect(typeof routesModule.routes).toBe('function');
    expect(typeof clientModule.createClient).toBe('function');
    await expect(runner.import('daroyan/rpc')).resolves.toBeDefined();
  } finally {
    await server.close();
    await rm(root, { recursive: true });
  }
});

test('response contracts survive the mount into the generated client', () => {
  const generated = createClient('http://localhost');

  // `route()` merges the sub-router's schema into the app's under the mount
  // path, so status literals and middleware response unions declared in route
  // files are still visible through `typeof app`. This is the property the
  // whole design rests on: the client type is derived from the app the user
  // assembled, not from a generated copy of it.
  expectTypeOf<
    Awaited<ReturnType<typeof generated.health.$post>>['status']
  >().toEqualTypeOf<201>();
  expectTypeOf<
    Awaited<ReturnType<typeof generated.secure.$get>>['status']
  >().toEqualTypeOf<200 | 401>();
});

test('a missing routes directory reports the resolved path and configuration option', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-missing-routes-`);

  await mkdir(`${root}/src`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*routes directory[\s\S]*src\/routes[\s\S]*routes:/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a missing app module reports the resolved path and configuration option', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-missing-app-`);

  await mkdir(`${root}/src/routes`, { recursive: true });

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*app module[\s\S]*src\/app\.ts[\s\S]*app:/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('the app module must default-export an instance created by defineApp', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-invalid-app-`);

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, 'export default { fetch() {} };\n');

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*src\/app\.ts[\s\S]*default[\s\S]*defineApp\(\)/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('an app syntax error reports the configured source file', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-app-syntax-error-`);
  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, 'export default defineApp(;\n');

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*(?:parse|syntax)[\s\S]*src\/app\.ts|src\/app\.ts[\s\S]*(?:parse|syntax)/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('the app module may retain Hono schema through a chained defineApp instance', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-chained-app-`);
  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(
    `${root}/src/app.ts`,
    [
      `import { defineApp } from ${JSON.stringify(
        fileURLToPath(new URL('../src/app.ts', import.meta.url))
      )};`,
      'const app = defineApp().get("/manual", (c) => c.json({ manual: true }));',
      'export default app;',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/routes/index.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).resolves.toBeDefined();
  } finally {
    await rm(root, { recursive: true });
  }
});

test('the app module may default-export a plain new Hono() instance', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-plain-hono-app-`);
  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(
    `${root}/src/app.ts`,
    ['import { Hono } from "hono";', 'export default new Hono();', ''].join(
      '\n'
    )
  );
  await writeFile(
    `${root}/src/routes/index.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).resolves.toBeDefined();
    await expect(
      readFile(`${root}/.daroyan/routes.ts`, 'utf8')
    ).resolves.toContain('.get("/"');
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a chained plain Hono app is accepted as the application root', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-plain-hono-chained-`);
  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(
    `${root}/src/app.ts`,
    [
      'import { Hono as HonoApp } from "hono";',
      'const app = new HonoApp().get("/manual", (c) => c.json({ manual: true }));',
      'export { app as default };',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/routes/index.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).resolves.toBeDefined();
  } finally {
    await rm(root, { recursive: true });
  }
});

test('the app instance may use a local default export list', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-app-export-list-`);
  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(
    `${root}/src/app.ts`,
    [
      `import { defineApp } from ${JSON.stringify(
        fileURLToPath(new URL('../src/app.ts', import.meta.url))
      )};`,
      'const app = defineApp();',
      'export { app as default };',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/routes/index.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).resolves.toBeDefined();
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a default route export must be a Hono sub-router', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-invalid-sub-router-`);

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/admin.ts`,
    'export default { fetch() {} };\n'
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*src\/routes\/admin\.ts[\s\S]*default export[\s\S]*Hono sub-router/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a chained Hono sub-router may use a local default export list', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-subrouter-export-list-`);

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/admin.ts`,
    [
      'import { Hono } from "hono";',
      'const admin = new Hono().get("/", (c) => c.json({ admin: true }));',
      'export { admin as default };',
      '',
    ].join('\n')
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).resolves.toBeDefined();
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a default sub-router rejects unchained route mutations', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-unchained-subrouter-`);

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/admin.ts`,
    [
      'import { Hono } from "hono";',
      'const admin = new Hono();',
      'admin.get("/", (c) => c.json({ admin: true }));',
      'export default admin;',
      '',
    ].join('\n')
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*src\/routes\/admin\.ts[\s\S]*(?:chain|chained)[\s\S]*(?:RPC|schema)/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a default sub-router rejects unchained middleware mutations', async () => {
  const root = await mkdtemp(
    `${tmpdir()}/daroyan-unchained-subrouter-middleware-`
  );

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/admin.ts`,
    [
      'import { Hono } from "hono";',
      'const admin = new Hono();',
      'admin.use("*", async (_c, next) => { await next(); });',
      'export default admin;',
      '',
    ].join('\n')
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*src\/routes\/admin\.ts[\s\S]*(?:chain|chained)[\s\S]*(?:RPC|schema)/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a named method export must be a handler tuple', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-invalid-handler-export-`);

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/health.ts`,
    'export const GET = (c: any) => c.json({ ok: true });\n'
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*src\/routes\/health\.ts[\s\S]*GET[\s\S]*defineHandler[\s\S]*tuple/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a supported method function declaration is rejected instead of silently ignored', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-method-function-export-`);

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/health.ts`,
    'export function GET(c: any) { return c.json({ ok: true }); }\n'
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*src\/routes\/health\.ts[\s\S]*GET[\s\S]*defineHandler[\s\S]*tuple/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('an external method re-export is rejected when its handler tuple cannot be proven', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-method-reexport-`);

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/_handler.ts`,
    'export function GET(c: any) { return c.json({ ok: true }); }\n'
  );
  await writeFile(
    `${root}/src/routes/health.ts`,
    'export { GET } from "./_handler.ts";\n'
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*src\/routes\/health\.ts[\s\S]*GET[\s\S]*defineHandler[\s\S]*tuple/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a named method cannot export an empty handler tuple', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-empty-handler-export-`);

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/health.ts`,
    [
      `import { defineHandler } from ${JSON.stringify(
        fileURLToPath(new URL('../src/app.ts', import.meta.url))
      )};`,
      'export const GET = defineHandler();',
      '',
    ].join('\n')
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*src\/routes\/health\.ts[\s\S]*GET[\s\S]*defineHandler[\s\S]*tuple/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a named method may come from a project wrapper or a shared tuple', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-wrapped-handler-`);

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/shared.ts`,
    [
      'export const shared = [(c: any) => c.json({ shared: true })] as const;',
      'export const withAudit = (...handlers: any[]) => handlers;',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/routes/health.ts`,
    [
      `import { defineHandler } from ${JSON.stringify(
        fileURLToPath(new URL('../src/app.ts', import.meta.url))
      )};`,
      'import { shared, withAudit } from "../shared.ts";',
      'export const GET = shared;',
      'export const POST = withAudit(...defineHandler((c) => c.json({ ok: true })));',
      '',
    ].join('\n')
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).resolves.toBeDefined();

    const router = await readFile(`${root}/.daroyan/routes.ts`, 'utf8');
    expect(router).toContain('.get("/health"');
    expect(router).toContain('.post("/health"');
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a named method tuple rejects values that cannot be handlers', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-invalid-handler-value-`);

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(`${root}/src/routes/health.js`, 'export const GET = [42];\n');

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*src\/routes\/health\.js[\s\S]*GET[\s\S]*(?:handler|tuple)/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a route syntax error reports the source file with Daroyan context', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-route-syntax-error-`);

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/health.ts`,
    'export const GET = [((c: any) => c.json({ ok: true })];\n'
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*(?:parse|syntax)[\s\S]*src\/routes\/health\.ts|src\/routes\/health\.ts[\s\S]*(?:parse|syntax)/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a route file with no supported method exports is ignored with a warning', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-empty-route-`);
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/helpers.ts`,
    'export const answer = 42;\n'
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      'serve'
    );

    expect(warnings.join('\n')).toMatch(
      /\[daroyan\][\s\S]*src\/routes\/helpers\.ts[\s\S]*no supported method[\s\S]*GET/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('directory middleware around a default sub-router warns about its RPC boundary', async () => {
  const root = await mkdtemp(
    `${tmpdir()}/daroyan-subrouter-middleware-warning-`
  );
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/src/routes/admin`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/admin/_middleware.ts`,
    [
      `import { defineMiddleware } from ${JSON.stringify(
        fileURLToPath(new URL('../src/app.ts', import.meta.url))
      )};`,
      'export default defineMiddleware(async (_c, next) => { await next(); });',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/routes/admin/index.ts`,
    [
      'import { Hono } from "hono";',
      'export default new Hono().get("/", (c) => c.json({ admin: true }));',
      '',
    ].join('\n')
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      'serve'
    );

    expect(warnings.join('\n')).toMatch(
      /\[daroyan\][\s\S]*src\/routes\/admin\/index\.ts[\s\S]*directory middleware[\s\S]*RPC[\s\S]*response/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('base-app early-response middleware warns about file-route RPC contracts', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-base-middleware-warning-`);
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(
    `${root}/src/app.ts`,
    [
      `import { defineApp } from ${JSON.stringify(
        fileURLToPath(new URL('../src/app.ts', import.meta.url))
      )};`,
      'const app = defineApp();',
      'app.use("*", (c) => c.json({ error: "UNAUTHORIZED" }, 401));',
      'export default app;',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/routes/index.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      'serve'
    );

    expect(warnings.join('\n')).toMatch(
      /\[daroyan\][\s\S]*src\/app\.ts[\s\S]*base-app middleware[\s\S]*RPC[\s\S]*response/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a provable parameter schema and filename mismatch emits a warning', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-param-schema-warning-`);
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/src/routes/users`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/users/$id.ts`,
    [
      'import { zValidator } from "@hono/zod-validator";',
      'import { z } from "zod";',
      'export const GET = [',
      '  zValidator("param", z.object({ userId: z.string() })),',
      '  (c: any) => c.json({ userId: c.req.valid("param").userId }),',
      '] as const;',
      '',
    ].join('\n')
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      'serve'
    );

    expect(warnings.join('\n')).toMatch(
      /\[daroyan\][\s\S]*src\/routes\/users\/\$id\.ts[\s\S]*parameter schema[\s\S]*userId[\s\S]*id/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a parameter schema mismatch is detected for non-zod Hono validators', async () => {
  const validators = [
    ['@hono/valibot-validator', 'vValidator'],
    ['@hono/arktype-validator', 'arktypeValidator'],
    ['@hono/standard-validator', 'sValidator'],
  ] as const;

  for (const [module, factory] of validators) {
    const root = await mkdtemp(`${tmpdir()}/daroyan-param-schema-${factory}-`);
    const warnings: string[] = [];
    const logger = createLogger('silent');
    logger.warn = (message) => {
      warnings.push(message);
    };

    await mkdir(`${root}/src/routes/users`, { recursive: true });
    await writeFile(`${root}/src/app.ts`, temporaryAppSource);
    await writeFile(
      `${root}/src/routes/users/$id.ts`,
      [
        `import { ${factory} } from ${JSON.stringify(module)};`,
        'import { z } from "zod";',
        'export const GET = [',
        `  ${factory}("param", z.object({ userId: z.string() })),`,
        '  (c: any) => c.json({ userId: c.req.valid("param").userId }),',
        '] as const;',
        '',
      ].join('\n')
    );

    try {
      await resolveConfig(
        { configFile: false, customLogger: logger, plugins: [daroyan()], root },
        'serve'
      );

      expect(warnings.join('\n'), factory).toMatch(
        /\[daroyan\][\s\S]*src\/routes\/users\/\$id\.ts[\s\S]*parameter schema[\s\S]*userId[\s\S]*id/i
      );
    } finally {
      await rm(root, { recursive: true });
    }
  }
});

test('a parameter schema mismatch is detected through a method export list', async () => {
  const root = await mkdtemp(
    `${tmpdir()}/daroyan-exported-param-schema-warning-`
  );
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/src/routes/users`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/users/$id.ts`,
    [
      'import { zValidator } from "@hono/zod-validator";',
      'import { z } from "zod";',
      'const handler = [',
      '  zValidator("param", z.object({ userId: z.string() })),',
      '  (c: any) => c.json({ userId: c.req.valid("param").userId }),',
      '] as const;',
      'export { handler as GET };',
      '',
    ].join('\n')
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      'serve'
    );

    expect(warnings.join('\n')).toMatch(
      /\[daroyan\][\s\S]*src\/routes\/users\/\$id\.ts[\s\S]*parameter schema[\s\S]*userId[\s\S]*id/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a parameter schema mismatch is detected through a local schema variable', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-local-param-schema-warning-`);
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/src/routes/users`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/users/$id.ts`,
    [
      'import { zValidator } from "@hono/zod-validator";',
      'import { z } from "zod";',
      'const params = z.object({ userId: z.string() });',
      'export const GET = [',
      '  zValidator("param", params),',
      '  (c: any) => c.json({ userId: c.req.valid("param").userId }),',
      '] as const;',
      '',
    ].join('\n')
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      'serve'
    );

    expect(warnings.join('\n')).toMatch(
      /\[daroyan\][\s\S]*src\/routes\/users\/\$id\.ts[\s\S]*parameter schema[\s\S]*userId[\s\S]*id/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a production build with no server entry fails before bundling with guidance', async () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const root = await mkdtemp(`${packageRoot}/.daroyan-missing-entry-`);

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);

  try {
    await expect(
      build({
        configFile: false,
        logLevel: 'silent',
        plugins: [daroyan()],
        root,
      })
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*server entry[\s\S]*src\/server\.ts[\s\S]*entry:/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('an incompatible TypeScript config receives a copy-pasteable correction', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-invalid-tsconfig-`);
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/tsconfig.json`,
    JSON.stringify({ compilerOptions: { strict: false }, include: ['src'] })
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      'serve'
    );

    expect(warnings.join('\n')).toMatch(
      /\[daroyan\][\s\S]*tsconfig\.json[\s\S]*"allowImportingTsExtensions": true[\s\S]*"strict": true[\s\S]*"module": "ESNext"[\s\S]*"moduleResolution": "Bundler"[\s\S]*"noEmit": true[\s\S]*"rootDirs"[\s\S]*\.daroyan\/types[\s\S]*\.daroyan\/\*\*\/\*\.ts/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a custom rpc.outDir is not told to extend the shipped base config', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-custom-outdir-tsconfig-`);
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/tsconfig.json`,
    JSON.stringify({ compilerOptions: { strict: false }, include: ['src'] })
  );

  try {
    await resolveConfig(
      {
        configFile: false,
        customLogger: logger,
        plugins: [daroyan({ rpc: { outDir: 'generated' } })],
        root,
      },
      'serve'
    );

    const warning = warnings.join('\n');
    expect(warning).toContain('generated/**/*.ts');
    expect(warning).not.toContain('"extends": "daroyan/tsconfig"');
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a TypeScript config extending a list of bases is understood', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-extends-list-`);
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/base.strict.json`,
    JSON.stringify({
      compilerOptions: {
        allowImportingTsExtensions: true,
        noEmit: true,
        strict: true,
      },
    })
  );
  await writeFile(
    `${root}/base.modules.json`,
    JSON.stringify({
      compilerOptions: {
        module: 'Preserve',
        moduleResolution: 'Bundler',
        rootDirs: ['.', './.daroyan/types'],
      },
      include: ['src', '.daroyan/**/*.d.ts', '.daroyan/**/*.ts'],
    })
  );
  await writeFile(
    `${root}/tsconfig.json`,
    JSON.stringify({ extends: ['./base.strict.json', './base.modules.json'] })
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      'serve'
    );

    expect(warnings.join('\n')).not.toContain('tsconfig.json');
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a missing TypeScript config receives the generated-types configuration', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-missing-tsconfig-`);
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      'serve'
    );

    expect(warnings.join('\n')).toMatch(
      /\[daroyan\][\s\S]*tsconfig\.json[\s\S]*missing[\s\S]*"allowImportingTsExtensions": true[\s\S]*"strict": true[\s\S]*"noEmit": true[\s\S]*"rootDirs"[\s\S]*\.daroyan\/types[\s\S]*include/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('TypeScript settings inherited from a relative config are accepted', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-extended-tsconfig-`);
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/tsconfig.base.json`,
    JSON.stringify({
      compilerOptions: {
        allowImportingTsExtensions: true,
        module: 'ESNext',
        moduleResolution: 'Bundler',
        noEmit: true,
        strict: true,
      },
    })
  );
  await writeFile(
    `${root}/tsconfig.json`,
    JSON.stringify({
      extends: './tsconfig.base.json',
      compilerOptions: {
        rootDirs: ['.', './.daroyan/types'],
      },
      include: ['src', '.daroyan/**/*.d.ts'],
    })
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      'serve'
    );

    expect(warnings).toEqual([]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('TypeScript settings inherited from a package config are accepted', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-package-tsconfig-`);
  const warnings: string[] = [];
  const logger = createLogger('silent');
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/src/routes`, { recursive: true });
  await mkdir(`${root}/node_modules/@example/tsconfig`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/node_modules/@example/tsconfig/package.json`,
    JSON.stringify({
      name: '@example/tsconfig',
      exports: './tsconfig.json',
    })
  );
  await writeFile(
    `${root}/node_modules/@example/tsconfig/tsconfig.json`,
    JSON.stringify({
      compilerOptions: {
        allowImportingTsExtensions: true,
        module: 'ESNext',
        moduleResolution: 'Bundler',
        noEmit: true,
        strict: true,
      },
    })
  );
  await writeFile(
    `${root}/tsconfig.json`,
    JSON.stringify({
      extends: '@example/tsconfig',
      compilerOptions: {
        rootDirs: ['.', './.daroyan/types'],
      },
      include: ['src', '.daroyan/**/*.d.ts'],
    })
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      'serve'
    );

    expect(warnings).toEqual([]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test.each(['emitDeclarationOnly', 'rewriteRelativeImportExtensions'] as const)(
  "TypeScript's %s mode supports explicit TypeScript import extensions",
  async (emissionOption) => {
    const root = await mkdtemp(`${tmpdir()}/daroyan-ts-extension-emission-`);
    const warnings: string[] = [];
    const logger = createLogger('silent');
    logger.warn = (message) => {
      warnings.push(message);
    };

    await mkdir(`${root}/src/routes`, { recursive: true });
    await writeFile(`${root}/src/app.ts`, temporaryAppSource);
    await writeFile(
      `${root}/tsconfig.json`,
      JSON.stringify({
        compilerOptions: {
          allowImportingTsExtensions: true,
          [emissionOption]: true,
          module: 'ESNext',
          moduleResolution: 'Bundler',
          rootDirs: ['.', './.daroyan/types'],
          strict: true,
        },
        include: ['src', '.daroyan/**/*.d.ts'],
      })
    );

    try {
      await resolveConfig(
        { configFile: false, customLogger: logger, plugins: [daroyan()], root },
        'serve'
      );

      expect(warnings).toEqual([]);
    } finally {
      await rm(root, { recursive: true });
    }
  }
);

test('_middleware.js is discovered for JavaScript route projects', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-js-middleware-`);

  await mkdir(`${root}/src/routes/api`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/api/_middleware.js`,
    'export default [(c, next) => next()];\n'
  );
  await writeFile(
    `${root}/src/routes/api/index.js`,
    'export const GET = [(c) => c.json({ ok: true })];\n'
  );

  try {
    await resolveConfig(
      { configFile: false, plugins: [daroyan()], root },
      'serve'
    );
    const manifest = JSON.parse(
      await readFile(`${root}/.daroyan/manifest.json`, 'utf8')
    ) as {
      routes: Array<{ middleware: string[]; path: string }>;
    };
    const router = await readFile(`${root}/.daroyan/routes.ts`, 'utf8');

    expect(manifest.routes).toContainEqual(
      expect.objectContaining({
        middleware: ['src/routes/api/_middleware.js'],
        path: '/api',
      })
    );
    expect(router).toContain('from "../src/routes/api/index.js";');
    expect(router).toContain('from "../src/routes/api/_middleware.js";');
  } finally {
    await rm(root, { recursive: true });
  }
});

test('directory middleware must default-export a middleware tuple', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-invalid-middleware-`);

  await mkdir(`${root}/src/routes/api`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/api/_middleware.ts`,
    'export default async function middleware(_c: any, next: () => Promise<void>) { await next(); }\n'
  );
  await writeFile(
    `${root}/src/routes/api/index.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*src\/routes\/api\/_middleware\.ts[\s\S]*default[\s\S]*defineMiddleware[\s\S]*tuple/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('directory middleware cannot export an empty middleware tuple', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-empty-middleware-`);
  await mkdir(`${root}/src/routes/api`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/api/_middleware.ts`,
    [
      `import { defineMiddleware } from ${JSON.stringify(
        fileURLToPath(new URL('../src/app.ts', import.meta.url))
      )};`,
      'export default defineMiddleware();',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/routes/api/index.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*src\/routes\/api\/_middleware\.ts[\s\S]*(?:one|non-empty)[\s\S]*middleware/i
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a group directory wraps its routes in middleware without entering the URL', async () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const root = await mkdtemp(`${packageRoot}/.daroyan-route-group-`);
  const helper = JSON.stringify(
    fileURLToPath(new URL('../src/app.ts', import.meta.url))
  );

  await mkdir(`${root}/src/routes/(authed)`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/(authed)/_middleware.ts`,
    [
      `import { defineMiddleware } from ${helper};`,
      'export default defineMiddleware(async (c, next) => {',
      '  c.set("group", "authed");',
      '  await next();',
      '});',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/routes/(authed)/orders.ts`,
    'export const GET = [(c: any) => c.json({ group: c.get("group") ?? null })] as const;\n'
  );
  await writeFile(
    `${root}/src/routes/health.ts`,
    'export const GET = [(c: any) => c.json({ group: c.get("group") ?? null })] as const;\n'
  );

  const server = await createServer({
    configFile: false,
    customLogger: createLogger('silent'),
    plugins: [daroyan()],
    root,
    server: { middlewareMode: true },
  });

  try {
    const runner = createServerModuleRunner(server.environments.ssr);
    const appModule = (await runner.import(`${root}/src/app.ts`)) as {
      default: { request(path: string): Promise<Response> };
    };

    // The group names no URL segment, yet its middleware still wraps the route,
    // and a sibling outside the group is untouched.
    await expect(
      (await appModule.default.request('/orders')).json()
    ).resolves.toEqual({ group: 'authed' });
    await expect(
      (await appModule.default.request('/health')).json()
    ).resolves.toEqual({ group: null });
    expect((await appModule.default.request('/(authed)/orders')).status).toBe(
      404
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true });
  }
});

test('a group directory keeps its middleware in the manifest but not in the path', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-route-group-manifest-`);
  const helper = JSON.stringify(
    fileURLToPath(new URL('../src/app.ts', import.meta.url))
  );

  await mkdir(`${root}/src/routes/(authed)`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/(authed)/_middleware.ts`,
    [
      `import { defineMiddleware } from ${helper};`,
      'export default defineMiddleware(async (_c, next) => { await next(); });',
      '',
    ].join('\n')
  );
  await writeFile(
    `${root}/src/routes/(authed)/orders.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  try {
    await resolveConfig(
      { configFile: false, plugins: [daroyan()], root },
      'serve'
    );
    const manifest = JSON.parse(
      await readFile(`${root}/.daroyan/manifest.json`, 'utf8')
    ) as {
      routes: Array<{ file: string; middleware: string[]; path: string }>;
    };

    expect(manifest.routes).toEqual([
      {
        file: 'src/routes/(authed)/orders.ts',
        kind: 'methods',
        methods: ['GET'],
        middleware: ['src/routes/(authed)/_middleware.ts'],
        path: '/orders',
      },
    ]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('group directories and escaped segments derive their URLs', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-segment-derivation-`);
  const expected = {
    '(a)/orders.ts': '/orders',
    '(a)/(b)/nested.ts': '/nested',
    '(a)/index.ts': '/',
    '(a)/$id.ts': '/:id',
    'files/$...path/(a)/index.ts': '/files/:path{.+}',
    '[(foo)].ts': '/(foo)',
    '[(bar)]/orders.ts': '/(bar)/orders',
    '[$]id.ts': '/$id',
    'v[$]1.ts': '/v$1',
    '[index].ts': '/index',
    '[[weird]].ts': '/[weird]',
    '[sitemap.xml].ts': '/sitemap.xml',
    // A name beginning with `[` is not `_`-prefixed on disk, so the ignore rules
    // never applied to it and the escape simply reaches the URL.
    '[_]internal.ts': '/_internal',
  };

  await mkdir(`${root}/src/routes`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  for (const file of Object.keys(expected)) {
    const directory = file.includes('/')
      ? `/${file.slice(0, file.lastIndexOf('/'))}`
      : '';
    await mkdir(`${root}/src/routes${directory}`, { recursive: true });
    await writeFile(
      `${root}/src/routes/${file}`,
      'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
    );
  }

  try {
    await resolveConfig(
      { configFile: false, plugins: [daroyan()], root },
      'serve'
    );
    const manifest = JSON.parse(
      await readFile(`${root}/.daroyan/manifest.json`, 'utf8')
    ) as {
      routes: Array<{ file: string; path: string }>;
    };

    expect(
      Object.fromEntries(
        manifest.routes.map((route) => [
          route.file.replace('src/routes/', ''),
          route.path,
        ])
      )
    ).toEqual(expected);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('malformed groups and unserviceable segments fail with their source file', async () => {
  const cases = [
    {
      file: '(foo).ts',
      pattern: /\(foo\)" names a route group, which only a directory can be/,
    },
    { file: '()/x.ts', pattern: /route group "\(\)" needs a name/ },
    { file: '( )/x.ts', pattern: /route group "\( \)" needs a name/ },
    {
      file: '($id)/x.ts',
      pattern: /route group "\(\$id\)" cannot declare a dynamic parameter/,
    },
    { file: '(authed/x.ts', pattern: /is not a valid route group/ },
    { file: 'authed)/x.ts', pattern: /is not a valid route group/ },
    { file: '$id[.pdf].ts', pattern: /cannot contain an escape/ },
    { file: '[{]id.ts', pattern: /which is Hono path syntax/ },
  ];

  for (const { file, pattern } of cases) {
    const root = await mkdtemp(`${tmpdir()}/daroyan-invalid-segment-`);
    const directory = file.includes('/')
      ? `/${file.slice(0, file.lastIndexOf('/'))}`
      : '';

    await mkdir(`${root}/src/routes${directory}`, { recursive: true });
    await writeFile(`${root}/src/app.ts`, temporaryAppSource);
    await writeFile(
      `${root}/src/routes/${file}`,
      'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
    );

    try {
      await expect(
        resolveConfig(
          { configFile: false, plugins: [daroyan()], root },
          'serve'
        )
      ).rejects.toThrow(pattern);
    } finally {
      await rm(root, { recursive: true });
    }
  }
});

test('a malformed group in directory middleware names the middleware file', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-group-middleware-error-`);
  const helper = JSON.stringify(
    fileURLToPath(new URL('../src/app.ts', import.meta.url))
  );

  await mkdir(`${root}/src/routes/($id)`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/($id)/_middleware.ts`,
    [
      `import { defineMiddleware } from ${helper};`,
      'export default defineMiddleware(async (_c, next) => { await next(); });',
      '',
    ].join('\n')
  );

  try {
    // The middleware's own URL is derived from a synthetic `index.ts`, which must
    // never appear in a diagnostic because the user never wrote it.
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, 'serve')
    ).rejects.toThrow(/\(\$id\)\/_middleware\.ts: route group/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('routes that collapse onto one URL through a group explain the collapse', async () => {
  const layouts = [
    ['(a)/orders.ts', 'orders.ts'],
    ['(a)/orders.ts', '(b)/orders.ts'],
  ];

  for (const files of layouts) {
    const root = await mkdtemp(`${tmpdir()}/daroyan-group-conflict-`);

    await mkdir(`${root}/src/routes`, { recursive: true });
    await writeFile(`${root}/src/app.ts`, temporaryAppSource);
    for (const file of files) {
      const directory = file.includes('/')
        ? `/${file.slice(0, file.lastIndexOf('/'))}`
        : '';
      await mkdir(`${root}/src/routes${directory}`, { recursive: true });
      await writeFile(
        `${root}/src/routes/${file}`,
        'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
      );
    }

    try {
      const error = await resolveConfig(
        { configFile: false, plugins: [daroyan()], root },
        'serve'
      ).then(
        () => undefined,
        (reason: unknown) => reason as Error
      );

      expect(error?.message).toContain('Route conflict at "/orders"');
      for (const file of files) {
        expect(error?.message).toContain(`src/routes/${file}`);
      }
      expect(error?.message).toContain(
        'A "(group)" directory contributes middleware only'
      );
    } finally {
      await rm(root, { recursive: true });
    }
  }
});

test('a route inside a group keeps its companion type on disk and its URL in the type', async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-group-companion-`);

  await mkdir(`${root}/src/routes/(authed)`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/(authed)/orders.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );

  try {
    await resolveConfig(
      { configFile: false, plugins: [daroyan()], root },
      'serve'
    );
    // The companion mirrors the source path so `./+types/orders.ts` resolves
    // through `rootDirs`, while the type it declares carries the served URL.
    const source = await readFile(
      `${root}/.daroyan/types/src/routes/(authed)/+types/orders.d.ts`,
      'utf8'
    );

    expect(source).toMatch(/path: "\/orders"/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a production build emits a grouped route under its on-disk path', async () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url));
  const root = await mkdtemp(`${packageRoot}/.daroyan-group-build-`);

  await mkdir(`${root}/src/routes/(authed)`, { recursive: true });
  await writeFile(`${root}/src/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/src/routes/(authed)/orders.ts`,
    'export const GET = [(c: any) => c.json({ ok: true })] as const;\n'
  );
  await writeFile(
    `${root}/src/server.ts`,
    ['import app from "./app.ts";', 'export default app;', ''].join('\n')
  );

  try {
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [daroyan()],
      root,
    });
    const outputs = Array.isArray(result) ? result : [result];
    const chunks = outputs
      .flatMap((output) => ('output' in output ? output.output : []))
      .filter((chunk) => chunk.type === 'chunk');

    // Rolldown sanitizes `$` out of emitted filenames but leaves parentheses
    // alone, so an unbundled build keeps the group directory intact.
    expect(chunks.map((chunk) => chunk.fileName)).toContain(
      'routes/(authed)/orders.mjs'
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a grouped fixture route reaches the client without its group segment', async () => {
  const response = await client.scoped.$get();

  // `client.scoped`, not `client['(grouped)'].scoped`: the group shapes
  // middleware, not the URL or the RPC contract. That this compiles at all is
  // the assertion — the group segment is absent from the generated client.
  expect(response.status).toBe(200);
  expect(response.headers.get('x-group')).toBe('grouped');
  await expect(response.json()).resolves.toEqual({ scoped: true });
});
