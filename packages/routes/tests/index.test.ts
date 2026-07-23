import { testClient } from "hono/testing";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  build,
  createLogger,
  createServer,
  createServerModuleRunner,
  resolveConfig,
} from "vite-plus";
import { expect, expectTypeOf, test } from "vite-plus/test";
import app from "daroyan/entry";
import { daroyan } from "../src/index.ts";
import { createClient } from "../.daroyan/client.ts";
import configuredApp from "./fixtures/basic/app/app.ts";

const client = testClient(app);
const temporaryAppSource = `import { defineApp } from ${JSON.stringify(
  fileURLToPath(new URL("../src/app.ts", import.meta.url)),
)};\nexport default defineApp();\n`;

test("the assembled entry exports the configured Hono instance itself", () => {
  expect(app).toBe(configuredApp);
});

test("a GET route is discovered, assembled, and available to the RPC client", async () => {
  const response = await client.health.$get();

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true });
});

test("HEAD uses the matching GET route and omits its response body", async () => {
  const response = await app.request("/health", { method: "HEAD" });

  expect(response.status).toBe(200);
  await expect(response.text()).resolves.toBe("");
});

test("one route module can expose multiple HTTP methods to runtime and RPC", async () => {
  const response = await client.health.$post();

  expectTypeOf(response.status).toEqualTypeOf<201>();
  expect(response.status).toBe(201);
  await expect(response.json()).resolves.toEqual({ created: true });
});

test("PUT, PATCH, DELETE, and OPTIONS exports reach runtime and RPC", async () => {
  const put = await client.verbs.$put();
  const patch = await client.verbs.$patch();
  const deleted = await client.verbs.$delete();
  const options = await client.verbs.$options();

  expectTypeOf(put.status).toEqualTypeOf<200>();
  expectTypeOf(patch.status).toEqualTypeOf<200>();
  expectTypeOf(deleted.status).toEqualTypeOf<200>();
  expectTypeOf(options.status).toEqualTypeOf<200>();
  await expect(put.json()).resolves.toEqual({ method: "PUT" });
  await expect(patch.json()).resolves.toEqual({ method: "PATCH" });
  await expect(deleted.json()).resolves.toEqual({ method: "DELETE" });
  await expect(options.json()).resolves.toEqual({ method: "OPTIONS" });
});

test("the app environment types route handlers without a repeated generic", async () => {
  const response = await client.whoami.$get();

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ requestId: "req_123" });
});

test("chained manual Hono routes remain available on the assembled app", async () => {
  const response = await app.request("/manual");

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ manual: true });
});

test("multiple directory middleware run once in order at the directory and descendants", async () => {
  for (const path of ["/api", "/api/users"]) {
    const response = await app.request(path);

    expect(response.headers.get("x-middleware-order")).toBe("first,second");
  }
});

test("ancestor directory middleware stack root-to-leaf", async () => {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const root = await mkdtemp(`${packageRoot}/.daroyan-middleware-hierarchy-`);
  const helper = JSON.stringify(fileURLToPath(new URL("../src/app.ts", import.meta.url)));
  await mkdir(`${root}/app/routes/api`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/_middleware.ts`,
    [
      `import { defineMiddleware } from ${helper};`,
      "export default defineMiddleware(async (c, next) => {",
      '  c.set("order", ["root"]);',
      "  await next();",
      "});",
      "",
    ].join("\n"),
  );
  await writeFile(
    `${root}/app/routes/api/_middleware.ts`,
    [
      `import { defineMiddleware } from ${helper};`,
      "export default defineMiddleware(async (c, next) => {",
      '  c.set("order", [...c.get("order"), "api"]);',
      "  await next();",
      "});",
      "",
    ].join("\n"),
  );
  await writeFile(
    `${root}/app/routes/index.ts`,
    'export const GET = [(c: any) => c.json({ order: c.get("order") })] as const;\n',
  );
  await writeFile(
    `${root}/app/routes/api/index.ts`,
    'export const GET = [(c: any) => c.json({ order: c.get("order") })] as const;\n',
  );

  const server = await createServer({
    configFile: false,
    customLogger: createLogger("silent"),
    plugins: [daroyan()],
    root,
    server: { middlewareMode: true },
  });

  try {
    const runner = createServerModuleRunner(server.environments.ssr);
    const entry = (await runner.import("daroyan/entry")) as {
      default: { request(path: string): Promise<Response> };
    };

    await expect((await entry.default.request("/")).json()).resolves.toEqual({
      order: ["root"],
    });
    await expect((await entry.default.request("/api")).json()).resolves.toEqual({
      order: ["root", "api"],
    });
  } finally {
    await server.close();
    await rm(root, { recursive: true });
  }
});

test("directory middleware responses are part of the RPC response union", async () => {
  const response = await client.secure.$get();

  expectTypeOf(response.status).toEqualTypeOf<200 | 401>();
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({ error: "UNAUTHORIZED" });
});

test("a default Hono subrouter runs at its mount and appears on the RPC client", async () => {
  const rootResponse = await client.admin.$get();
  const statsResponse = await client.admin.stats.$get();

  expect(rootResponse.status).toBe(200);
  await expect(rootResponse.json()).resolves.toEqual({ section: "admin" });
  await expect(statsResponse.json()).resolves.toEqual({ activeUsers: 42 });
});

test("directory middleware surrounds a default sub-router mount exactly once", async () => {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const root = await mkdtemp(`${packageRoot}/.daroyan-subrouter-middleware-runtime-`);
  await mkdir(`${root}/app/routes/admin`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/admin/_middleware.ts`,
    [
      `import { defineMiddleware } from ${JSON.stringify(
        fileURLToPath(new URL("../src/app.ts", import.meta.url)),
      )};`,
      "export default defineMiddleware(async (c, next) => {",
      '  c.set("middlewareRuns", (c.get("middlewareRuns") ?? 0) + 1);',
      "  await next();",
      "});",
      "",
    ].join("\n"),
  );
  await writeFile(
    `${root}/app/routes/admin/index.ts`,
    [
      'import { Hono } from "hono";',
      "export default new Hono<any>()",
      '  .get("/", (c) => c.json({ middlewareRuns: c.get("middlewareRuns"), page: "root" }))',
      '  .get("/stats", (c) => c.json({ middlewareRuns: c.get("middlewareRuns"), page: "stats" }));',
      "",
    ].join("\n"),
  );

  const server = await createServer({
    configFile: false,
    customLogger: createLogger("silent"),
    plugins: [daroyan()],
    root,
    server: { middlewareMode: true },
  });

  try {
    const runner = createServerModuleRunner(server.environments.ssr);
    const entry = (await runner.import("daroyan/entry")) as {
      default: { request(path: string): Promise<Response> };
    };

    for (const path of ["/admin", "/admin/stats"]) {
      const response = await entry.default.request(path);
      await expect(response.json()).resolves.toMatchObject({ middlewareRuns: 1 });
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true });
  }
});

test("conflicting file routes fail configuration with both source files", async () => {
  const root = fileURLToPath(new URL("./fixtures/conflict", import.meta.url));

  await expect(
    resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
  ).rejects.toThrow(
    /\[daroyan\][\s\S]*\/users[\s\S]*(?:users\.ts[\s\S]*users\/index\.ts|users\/index\.ts[\s\S]*users\.ts)/,
  );
});

test("equivalent dynamic route shapes conflict even when parameter names differ", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-dynamic-shape-conflict-`);

  await mkdir(`${root}/app/routes/users`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/users/$id.ts`,
    "export const GET = [(c: any) => c.json({ id: c.req.param('id') })] as const;\n",
  );
  await writeFile(
    `${root}/app/routes/users/$slug.ts`,
    "export const GET = [(c: any) => c.json({ slug: c.req.param('slug') })] as const;\n",
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*\/users\/:id[\s\S]*(?:\$id\.ts[\s\S]*\$slug\.ts|\$slug\.ts[\s\S]*\$id\.ts)/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a default sub-router reports ownership of its descendant namespace", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-subrouter-namespace-conflict-`);
  await mkdir(`${root}/app/routes/admin`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/admin.ts`,
    [
      'import { Hono } from "hono";',
      'export default new Hono().get("/", (c) => c.json({ admin: true }));',
      "",
    ].join("\n"),
  );
  await writeFile(
    `${root}/app/routes/admin/stats.ts`,
    "export const GET = [(c: any) => c.json({ active: 1 })] as const;\n",
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*\/admin[\s\S]*admin\.ts[\s\S]*admin\/stats\.ts[\s\S]*owns[\s\S]*namespace/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a default sub-router namespace rejects dynamically matching descendants", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-dynamic-namespace-conflict-`);
  await mkdir(`${root}/app/routes/$section`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/admin.ts`,
    [
      'import { Hono } from "hono";',
      'export default new Hono().get("/stats", (c) => c.json({ admin: true }));',
      "",
    ].join("\n"),
  );
  await writeFile(
    `${root}/app/routes/$section/stats.ts`,
    "export const GET = [(c: any) => c.json({ section: c.req.param('section') })] as const;\n",
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*namespace conflict[\s\S]*\/admin[\s\S]*(?:admin\.ts[\s\S]*\$section\/stats\.ts|\$section\/stats\.ts[\s\S]*admin\.ts)/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the generated client exposes the assembled application contract", () => {
  const generatedClient = createClient("http://localhost");

  expectTypeOf(generatedClient.health.$get).toBeFunction();
  expectTypeOf(generatedClient.manual.$get).toBeFunction();
  expectTypeOf(generatedClient.admin.stats.$get).toBeFunction();
});

test("a package that exposes generated RPC warns when its client export is missing", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-client-export-warning-`);
  const warnings: string[] = [];
  const logger = createLogger("silent");
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/package.json`,
    JSON.stringify({
      name: "@example/api",
      exports: {
        "./rpc": "./.daroyan/rpc.ts",
      },
    }),
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      "serve",
    );

    expect(warnings.join("\n")).toMatch(
      /\[daroyan\][\s\S]*package\.json[\s\S]*generated client[\s\S]*\.\/client[\s\S]*\.daroyan\/client\.ts/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("generation writes a project-relative normalized manifest", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../.daroyan/manifest.json", import.meta.url), "utf8"),
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

  expect(manifest.version).toBe(1);
  expect(manifest.routes).toContainEqual({
    file: "tests/fixtures/basic/app/routes/health.ts",
    kind: "methods",
    methods: ["GET", "POST"],
    middleware: [],
    path: "/health",
  });
  expect(manifest.routes).toContainEqual({
    file: "tests/fixtures/basic/app/routes/admin.ts",
    kind: "sub-router",
    middleware: [],
    mountPath: "/admin",
  });
});

test("an optional route companion provides exact filename parameter types", async () => {
  const response = await client.api.users[":id"].$get({
    param: { id: "usr_123" },
  });

  // @ts-expect-error Pending the strict companion API decision: an explicit
  // Route generic currently widens the handler response status.
  expectTypeOf(response.status).toEqualTypeOf<200>();
  await expect(response.json()).resolves.toEqual({ id: "usr_123" });
});

test("a route companion exposes its contract through Route.Handler", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-route-handler-companion-`);

  await mkdir(`${root}/app/routes/users`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/users/$id.ts`,
    "export const GET = [(c: any) => c.json({ id: c.req.param('id') })] as const;\n",
  );

  try {
    await resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve");
    const source = await readFile(
      `${root}/.daroyan/types/app/routes/users/+types/$id.d.ts`,
      "utf8",
    );

    expect(source).toMatch(
      /export namespace Route \{[\s\S]*export type Handler = DaroyanRoute<\{[\s\S]*path: "\/users\/:id"/,
    );
    expect(source).not.toMatch(/export type Route\s*=/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("route companions are generated correctly when the project path contains spaces", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan route types `);
  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/health.ts`,
    "export const GET = [(c: any) => c.json({ ok: true })] as const;\n",
  );

  try {
    await resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve");

    await expect(
      readFile(`${root}/.daroyan/types/app/routes/+types/health.d.ts`, "utf8"),
    ).resolves.toContain('path: "/health"');
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a route handler accepts route-local middleware", async () => {
  const response = await client.local.$get();

  await expect(response.json()).resolves.toEqual({ requestId: "req_local" });
});

test("unchanged generated files retain their modification time", async () => {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const fixtureRoot = fileURLToPath(new URL("./fixtures/basic", import.meta.url));
  const rpcFile = new URL("../.daroyan/rpc.ts", import.meta.url);
  const unchangedTime = new Date("2020-01-02T03:04:05.000Z");

  await utimes(rpcFile, unchangedTime, unchangedTime);
  await resolveConfig(
    {
      configFile: false,
      plugins: [
        daroyan({
          app: `${fixtureRoot}/app/app.ts`,
          routes: `${fixtureRoot}/app/routes`,
        }),
      ],
      root: packageRoot,
    },
    "serve",
  );

  expect((await stat(rpcFile)).mtimeMs).toBe(unchangedTime.getTime());
});

test("a generation write failure leaves the previous RPC contract intact", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-generation-transaction-`);
  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/health.ts`,
    "export const GET = [(c: any) => c.json({ ok: true })] as const;\n",
  );

  try {
    await resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve");
    const previousManifest = await readFile(`${root}/.daroyan/manifest.json`, "utf8");
    const previousRpc = await readFile(`${root}/.daroyan/rpc.ts`, "utf8");

    await writeFile(
      `${root}/app/routes/api.ts`,
      "export const GET = [(c: any) => c.json({ api: true })] as const;\n",
    );
    await mkdir(`${root}/.daroyan/types/app/routes/+types/api.d.ts`, {
      recursive: true,
    });

    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).rejects.toThrow();

    await expect(readFile(`${root}/.daroyan/manifest.json`, "utf8")).resolves.toBe(
      previousManifest,
    );
    await expect(readFile(`${root}/.daroyan/rpc.ts`, "utf8")).resolves.toBe(previousRpc);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("generated artifacts identify their format and warn against editing", async () => {
  const rpc = await readFile(new URL("../.daroyan/rpc.ts", import.meta.url), "utf8");
  const manifest = await readFile(new URL("../.daroyan/manifest.json", import.meta.url), "utf8");

  expect(rpc).toMatch(/^\/\/ Generated by Daroyan \(format 1\)\. Do not edit\./);
  expect(manifest).toMatch(/^\{\n  "_notice": "Generated by Daroyan \(format 1\)\. Do not edit\."/);
});

test("basePath prefixes normalized runtime and RPC routes", async () => {
  const root = fileURLToPath(new URL("./fixtures/basepath", import.meta.url));

  await resolveConfig(
    { configFile: false, plugins: [daroyan({ basePath: "/v1/" })], root },
    "serve",
  );
  const manifest = JSON.parse(
    await readFile(new URL("./fixtures/basepath/.daroyan/manifest.json", import.meta.url), "utf8"),
  ) as { basePath: string; routes: Array<{ path: string }> };

  expect(manifest.basePath).toBe("/v1");
  expect(manifest.routes[0]?.path).toBe("/v1/health");
});

test("an invalid basePath fails with the Daroyan option name", async () => {
  const root = fileURLToPath(new URL("./fixtures/basepath", import.meta.url));

  await expect(
    resolveConfig(
      {
        configFile: false,
        plugins: [daroyan({ basePath: "api" as "/api" })],
        root,
      },
      "serve",
    ),
  ).rejects.toThrow(/\[daroyan\][\s\S]*basePath[\s\S]*start[\s\S]*\//i);
});

test("defineHandler preserves an arbitrary route-local middleware tuple", async () => {
  const response = await client.pipeline.$get();

  expect(response.headers.get("x-pipeline-first")).toBe("yes");
  expect(response.headers.get("x-pipeline-second")).toBe("yes");
  await expect(response.json()).resolves.toEqual({ complete: true });
});

test("the plugin configures the user-owned server as the production build entry", async () => {
  const root = fileURLToPath(new URL("./fixtures/basepath", import.meta.url));
  const config = await resolveConfig(
    {
      configFile: false,
      plugins: [
        daroyan({
          build: {
            fileName: "api.mjs",
            minify: true,
            outDir: "output",
            sourcemap: "inline",
          },
          entry: "app/server.ts",
        }),
      ],
      root,
    },
    "build",
  );

  expect(config.build.outDir).toBe("output");
  expect(config.build.sourcemap).toBe("inline");
  expect(config.build.minify).toBe("oxc");
  expect(config.build.ssr).toBe(`${root}/app/server.ts`);
});

test("zValidator provides runtime and RPC parameter validation without Route", async () => {
  const validResponse = await client.validated[":id"].$get({
    param: { id: "usr_123" },
  });
  const invalidResponse = await client.validated[":id"].$get({
    param: { id: "x" },
  });

  expectTypeOf(invalidResponse.status).toEqualTypeOf<200 | 400>();
  await expect(validResponse.json()).resolves.toEqual({ id: "usr_123" });
  expect(invalidResponse.status).toBe(400);
});

test("test files are excluded from route discovery", async () => {
  const response = await app.request("/ignored.spec.route");

  expect(response.status).toBe(404);
});

test("reserved basenames and directories are excluded from route discovery", async () => {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const root = await mkdtemp(`${packageRoot}/.daroyan-ignored-routes-`);
  const ignoredFiles = [
    "app/routes/_private.ts",
    "app/routes/.hidden.ts",
    "app/routes/types.d.ts",
    "app/routes/unit.test.ts",
    "app/routes/behavior.spec.js",
    "app/routes/__tests__/route.ts",
    "app/routes/__fixtures__/route.ts",
    "app/routes/+types/route.ts",
    "app/routes/.generated/route.ts",
  ];

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/visible.ts`,
    "export const GET = [(c: any) => c.json({ visible: true })] as const;\n",
  );
  for (const file of ignoredFiles) {
    await mkdir(`${root}/${file.slice(0, file.lastIndexOf("/"))}`, { recursive: true });
    await writeFile(
      `${root}/${file}`,
      "export const GET = [(c: any) => c.json({ ignored: true })] as const;\n",
    );
  }

  const server = await createServer({
    configFile: false,
    customLogger: createLogger("silent"),
    plugins: [daroyan()],
    root,
    server: { middlewareMode: true },
  });

  try {
    const runner = createServerModuleRunner(server.environments.ssr);
    const entry = (await runner.import("daroyan/entry")) as {
      default: { request(path: string): Promise<Response> };
    };

    expect((await entry.default.request("/visible")).status).toBe(200);
    for (const path of [
      "/_private",
      "/.hidden",
      "/types.d",
      "/unit.test",
      "/behavior.spec",
      "/__tests__/route",
      "/__fixtures__/route",
      "/+types/route",
      "/.generated/route",
    ]) {
      expect((await entry.default.request(path)).status).toBe(404);
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true });
  }
});

test("ignoredRouteFiles excludes route-relative minimatch globs", async () => {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const root = await mkdtemp(`${packageRoot}/.daroyan-custom-ignored-routes-`);

  await mkdir(`${root}/app/routes/internal`, { recursive: true });
  await mkdir(`${root}/app/routes/public`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/internal/_middleware.ts`,
    "throw new Error('ignored middleware must not be loaded');\n",
  );
  await writeFile(
    `${root}/app/routes/internal/health.ts`,
    "export const GET = [(c: any) => c.json({ internal: true })] as const;\n",
  );
  await writeFile(
    `${root}/app/routes/public/health.ts`,
    "export const GET = [(c: any) => c.json({ public: true })] as const;\n",
  );

  const server = await createServer({
    configFile: false,
    customLogger: createLogger("silent"),
    plugins: [daroyan({ ignoredRouteFiles: ["internal/**"] })],
    root,
    server: { middlewareMode: true },
  });

  try {
    const runner = createServerModuleRunner(server.environments.ssr);
    const entry = (await runner.import("daroyan/entry")) as {
      default: { request(path: string): Promise<Response> };
    };

    expect((await entry.default.request("/internal/health")).status).toBe(404);
    expect((await entry.default.request("/public/health")).status).toBe(200);
  } finally {
    await server.close();
    await rm(root, { recursive: true });
  }
});

test("a catch-all route captures one or more path segments", async () => {
  const response = await app.request("/files/reports/2026/july");
  const emptyResponse = await app.request("/files");

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ path: "reports/2026/july" });
  expect(emptyResponse.status).toBe(404);
});

test("nested dynamic directories and files contribute typed route parameters", async () => {
  const response = await client.teams[":teamId"].members[":memberId"].$get({
    param: {
      memberId: "mem_456",
      teamId: "team_123",
    },
  });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    memberId: "mem_456",
    teamId: "team_123",
  });
});

test("rpc.outDir relocates all generated artifacts", async () => {
  const root = fileURLToPath(new URL("./fixtures/basepath", import.meta.url));

  await resolveConfig(
    {
      configFile: false,
      plugins: [daroyan({ rpc: { outDir: ".generated" } })],
      root,
    },
    "serve",
  );

  const manifest = await readFile(
    new URL("./fixtures/basepath/.generated/manifest.json", import.meta.url),
    "utf8",
  );
  expect(JSON.parse(manifest)).toMatchObject({ version: 1 });
  await rm(new URL("./fixtures/basepath/.generated", import.meta.url), {
    recursive: true,
  });
});

test("rpc.outDir cannot target the project root", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-root-output-`);
  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/index.ts`,
    "export const GET = [(c: any) => c.json({ ok: true })] as const;\n",
  );

  try {
    await expect(
      resolveConfig(
        {
          configFile: false,
          plugins: [daroyan({ rpc: { outDir: "." } })],
          root,
        },
        "serve",
      ),
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*rpc\.outDir[\s\S]*project root[\s\S]*(?:generated|directory)/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("one TypeScript project cannot install multiple Daroyan applications", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-multiple-apps-`);

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/index.ts`,
    "export const GET = [(c: any) => c.json({ ok: true })] as const;\n",
  );

  try {
    await expect(
      resolveConfig(
        {
          configFile: false,
          plugins: [daroyan(), daroyan()],
          root,
        },
        "serve",
      ),
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*(?:one|multiple)[\s\S]*(?:application|plugin)[\s\S]*TypeScript project/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("adding a route during development regenerates every route-derived artifact", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-route-add-`);
  const routesDirectory = `${root}/app/routes`;
  const routeFile = `${routesDirectory}/notes.ts`;
  const manifestFile = `${root}/.daroyan/manifest.json`;
  const rpcFile = `${root}/.daroyan/rpc.ts`;
  const companionFile = `${root}/.daroyan/types/app/routes/+types/notes.d.ts`;

  await mkdir(routesDirectory, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);

  const server = await createServer({
    configFile: false,
    plugins: [daroyan()],
    root,
    server: { middlewareMode: true },
  });

  try {
    await expect.poll(() => Object.keys(server.watcher.getWatched())).toContain(routesDirectory);
    await writeFile(
      routeFile,
      'export const GET = [(c: any) => c.json({ resource: "notes" })] as const;\n',
    );

    await expect
      .poll(
        async () => {
          const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as {
            routes: Array<{ path: string }>;
          };
          return manifest.routes.map((route) => route.path);
        },
        { timeout: 5_000 },
      )
      .toContain("/notes");

    await expect(readFile(rpcFile, "utf8")).resolves.toContain('.get("/notes"');
    await expect(readFile(companionFile, "utf8")).resolves.toContain('path: "/notes"');
    await expect(server.transformRequest("daroyan/entry")).resolves.toMatchObject({
      code: expect.stringContaining('app.on("GET", "/notes"'),
    });
  } finally {
    await server.close();
    await rm(root, { recursive: true });
  }
}, 15_000);

test("removing a route during development deletes its stale companion and registrations", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-route-remove-`);
  const routesDirectory = `${root}/app/routes`;
  const routeFile = `${routesDirectory}/notes.ts`;
  const manifestFile = `${root}/.daroyan/manifest.json`;
  const rpcFile = `${root}/.daroyan/rpc.ts`;
  const companionFile = `${root}/.daroyan/types/app/routes/+types/notes.d.ts`;

  await mkdir(routesDirectory, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    routeFile,
    'export const GET = [(c: any) => c.json({ resource: "notes" })] as const;\n',
  );

  const server = await createServer({
    configFile: false,
    plugins: [daroyan()],
    root,
    server: { middlewareMode: true },
  });

  try {
    await expect(readFile(companionFile, "utf8")).resolves.toContain('path: "/notes"');
    await expect
      .poll(() =>
        Object.values(server.watcher.getWatched())
          .flat()
          .some((file) => file === "notes.ts"),
      )
      .toBe(true);
    await rm(routeFile);

    await expect
      .poll(
        async () => {
          const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as {
            routes: Array<{ path: string }>;
          };
          return manifest.routes.map((route) => route.path);
        },
        { timeout: 5_000 },
      )
      .not.toContain("/notes");

    await expect(readFile(rpcFile, "utf8")).resolves.not.toContain('.get("/notes"');
    await expect(readFile(companionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(server.transformRequest("daroyan/entry")).resolves.toMatchObject({
      code: expect.not.stringContaining('app.on("GET", "/notes"'),
    });
  } finally {
    await server.close();
    await rm(root, { recursive: true });
  }
}, 15_000);

test("routes register in static, dynamic, then catch-all priority", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-route-order-`);
  const routesDirectory = `${root}/app/routes/items`;

  await mkdir(routesDirectory, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  for (const file of ["$id.ts", "$...path.ts", "all.ts"]) {
    await writeFile(
      `${routesDirectory}/${file}`,
      "export const GET = [(c: any) => c.json({ ok: true })] as const;\n",
    );
  }

  try {
    await resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve");
    const manifest = JSON.parse(await readFile(`${root}/.daroyan/manifest.json`, "utf8")) as {
      routes: Array<{ path: string }>;
    };

    expect(manifest.routes.map((route) => route.path)).toEqual([
      "/items/all",
      "/items/:id",
      "/items/:path{.+}",
    ]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a catch-all segment before the end of a route fails with its source file", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-invalid-catch-all-`);
  const routesDirectory = `${root}/app/routes/files/$...path`;

  await mkdir(routesDirectory, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${routesDirectory}/edit.ts`,
    "export const GET = [(c: any) => c.json({ ok: true })] as const;\n",
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).rejects.toThrow(/app\/routes\/files\/\$\.\.\.path\/edit\.ts[\s\S]*catch-all[\s\S]*final/i);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("an invalid dynamic parameter name fails with its source file and parameter", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-invalid-parameter-`);
  const routesDirectory = `${root}/app/routes/users`;

  await mkdir(routesDirectory, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${routesDirectory}/$bad-name.ts`,
    "export const GET = [(c: any) => c.json({ ok: true })] as const;\n",
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).rejects.toThrow(
      /app\/routes\/users\/\$bad-name\.ts[\s\S]*invalid dynamic parameter name[\s\S]*bad-name/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("duplicate dynamic parameter names in one route fail before generation", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-duplicate-route-parameter-`);

  await mkdir(`${root}/app/routes/teams/$id/members`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/teams/$id/members/$id.ts`,
    "export const GET = [(c: any) => c.json({ id: c.req.param('id') })] as const;\n",
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*teams\/\$id\/members\/\$id\.ts[\s\S]*duplicate[\s\S]*parameter[\s\S]*"id"/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a route cannot mix a default sub-router with named method exports", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-mixed-route-`);
  const routesDirectory = `${root}/app/routes`;
  const routeFile = `${routesDirectory}/admin.ts`;

  await mkdir(routesDirectory, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    routeFile,
    [
      'import { Hono } from "hono";',
      "export const GET = [(c: any) => c.json({ ok: true })] as const;",
      "export default new Hono();",
      "",
    ].join("\n"),
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).rejects.toThrow(/app\/routes\/admin\.ts[\s\S]*cannot mix[\s\S]*default[\s\S]*GET/i);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a named method exported through an export list is discovered", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-export-list-`);
  const routesDirectory = `${root}/app/routes`;

  await mkdir(routesDirectory, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${routesDirectory}/health.ts`,
    ["const GET = [(c: any) => c.json({ ok: true })] as const;", "export { GET };", ""].join("\n"),
  );

  try {
    await resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve");
    const manifest = JSON.parse(await readFile(`${root}/.daroyan/manifest.json`, "utf8")) as {
      routes: Array<{ methods: string[]; path: string }>;
    };

    expect(manifest.routes).toContainEqual(
      expect.objectContaining({ methods: ["GET"], path: "/health" }),
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("directory middleware receives an optional generated companion type", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-middleware-companion-`);
  const helper = JSON.stringify(fileURLToPath(new URL("../src/app.ts", import.meta.url)));

  await mkdir(`${root}/app/routes/api`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/api/_middleware.ts`,
    [
      `import { defineMiddleware } from ${helper};`,
      "export default defineMiddleware(",
      "  async (_c, next) => { await next(); },",
      "  async (_c, next) => { await next(); },",
      ");",
      "",
    ].join("\n"),
  );
  await writeFile(
    `${root}/app/routes/api/index.ts`,
    "export const GET = [(c: any) => c.text('ok')] as const;\n",
  );

  try {
    await resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve");
    const source = await readFile(
      `${root}/.daroyan/types/app/routes/api/+types/_middleware.d.ts`,
      "utf8",
    );

    expect(source).toMatch(
      /export namespace Route \{[\s\S]*export type Middleware = DaroyanMiddleware<\{[\s\S]*path: "\/api"/,
    );
    expect(source).not.toMatch(/^export type Middleware\s*=/m);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a production build fails when it emits more than one JavaScript chunk", async () => {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const root = await mkdtemp(`${packageRoot}/.daroyan-split-build-`);

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/health.ts`,
    "export const GET = [(c: any) => c.json({ ok: true })] as const;\n",
  );
  await writeFile(`${root}/app/lazy.ts`, "export const value = 42;\n");
  await writeFile(
    `${root}/app/server.ts`,
    [
      'import app from "daroyan/entry";',
      'export const lazy = import("./lazy.ts");',
      "export default app;",
      "",
    ].join("\n"),
  );

  try {
    await expect(
      build({
        configFile: false,
        logLevel: "silent",
        plugins: [daroyan()],
        root,
      }),
    ).rejects.toThrow(/daroyan[\s\S]*multiple javascript chunks[\s\S]*single entry/i);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a production build warns when it emits an external runtime asset", async () => {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const root = await mkdtemp(`${packageRoot}/.daroyan-external-asset-`);
  const warnings: string[] = [];
  const logger = createLogger("silent");
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/index.ts`,
    "export const GET = [(c: any) => c.json({ ok: true })] as const;\n",
  );
  await writeFile(`${root}/app/runtime.txt`, "runtime asset\n".repeat(100));
  await writeFile(
    `${root}/app/server.ts`,
    [
      'import runtimeAsset from "./runtime.txt?url";',
      'import app from "daroyan/entry";',
      "console.log(runtimeAsset);",
      "export default app;",
      "",
    ].join("\n"),
  );

  try {
    await build({
      build: { assetsInlineLimit: 0 },
      configFile: false,
      customLogger: logger,
      plugins: [daroyan()],
      root,
    });

    expect(warnings.join("\n")).toMatch(
      /\[daroyan\][\s\S]*external runtime asset[\s\S]*one-entry/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a production build rejects an unexpected server entry filename", async () => {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const root = await mkdtemp(`${packageRoot}/.daroyan-entry-filename-`);

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/index.ts`,
    "export const GET = [(c: any) => c.json({ ok: true })] as const;\n",
  );
  await writeFile(
    `${root}/app/server.ts`,
    'import app from "daroyan/entry";\nexport default app;\n',
  );

  try {
    await expect(
      build({
        configFile: false,
        logLevel: "silent",
        plugins: [
          daroyan(),
          {
            name: "override-daroyan-entry-filename",
            config: () => ({
              build: {
                rolldownOptions: {
                  output: { entryFileNames: "unexpected.mjs" },
                },
              },
            }),
          },
        ],
        root,
      }),
    ).rejects.toThrow(/\[daroyan\][\s\S]*unexpected\.mjs[\s\S]*server\.mjs[\s\S]*entry filename/i);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("rpc.enabled false keeps routing typegen but omits RPC client artifacts", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-rpc-disabled-`);

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/health.ts`,
    "export const GET = [(c: any) => c.json({ ok: true })] as const;\n",
  );

  try {
    await resolveConfig(
      {
        configFile: false,
        plugins: [daroyan({ rpc: { enabled: false } })],
        root,
      },
      "serve",
    );

    await expect(readFile(`${root}/.daroyan/manifest.json`, "utf8")).resolves.toContain(
      '"/health"',
    );
    await expect(
      readFile(`${root}/.daroyan/types/app/routes/+types/health.d.ts`, "utf8"),
    ).resolves.toContain('path: "/health"');
    await expect(readFile(`${root}/.daroyan/rpc.ts`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(`${root}/.daroyan/client.ts`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a missing routes directory reports the resolved path and configuration option", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-missing-routes-`);

  await mkdir(`${root}/app`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).rejects.toThrow(/\[daroyan\][\s\S]*routes directory[\s\S]*app\/routes[\s\S]*routes:/i);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a missing app module reports the resolved path and configuration option", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-missing-app-`);

  await mkdir(`${root}/app/routes`, { recursive: true });

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).rejects.toThrow(/\[daroyan\][\s\S]*app module[\s\S]*app\/app\.ts[\s\S]*app:/i);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the app module must default-export an instance created by defineApp", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-invalid-app-`);

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, "export default { fetch() {} };\n");

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).rejects.toThrow(/\[daroyan\][\s\S]*app\/app\.ts[\s\S]*default[\s\S]*defineApp\(\)/i);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("an app syntax error reports the configured source file", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-app-syntax-error-`);
  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, "export default defineApp(;\n");

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*(?:parse|syntax)[\s\S]*app\/app\.ts|app\/app\.ts[\s\S]*(?:parse|syntax)/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the app module may retain Hono schema through a chained defineApp instance", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-chained-app-`);
  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(
    `${root}/app/app.ts`,
    [
      `import { defineApp } from ${JSON.stringify(
        fileURLToPath(new URL("../src/app.ts", import.meta.url)),
      )};`,
      'const app = defineApp().get("/manual", (c) => c.json({ manual: true }));',
      "export default app;",
      "",
    ].join("\n"),
  );
  await writeFile(
    `${root}/app/routes/index.ts`,
    "export const GET = [(c: any) => c.json({ ok: true })] as const;\n",
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).resolves.toBeDefined();
  } finally {
    await rm(root, { recursive: true });
  }
});

test("the app instance may use a local default export list", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-app-export-list-`);
  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(
    `${root}/app/app.ts`,
    [
      `import { defineApp } from ${JSON.stringify(
        fileURLToPath(new URL("../src/app.ts", import.meta.url)),
      )};`,
      "const app = defineApp();",
      "export { app as default };",
      "",
    ].join("\n"),
  );
  await writeFile(
    `${root}/app/routes/index.ts`,
    "export const GET = [(c: any) => c.json({ ok: true })] as const;\n",
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).resolves.toBeDefined();
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a default route export must be a Hono sub-router", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-invalid-sub-router-`);

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(`${root}/app/routes/admin.ts`, "export default { fetch() {} };\n");

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*app\/routes\/admin\.ts[\s\S]*default export[\s\S]*Hono sub-router/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a chained Hono sub-router may use a local default export list", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-subrouter-export-list-`);

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/admin.ts`,
    [
      'import { Hono } from "hono";',
      'const admin = new Hono().get("/", (c) => c.json({ admin: true }));',
      "export { admin as default };",
      "",
    ].join("\n"),
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).resolves.toBeDefined();
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a default sub-router rejects unchained route mutations", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-unchained-subrouter-`);

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/admin.ts`,
    [
      'import { Hono } from "hono";',
      "const admin = new Hono();",
      'admin.get("/", (c) => c.json({ admin: true }));',
      "export default admin;",
      "",
    ].join("\n"),
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*app\/routes\/admin\.ts[\s\S]*(?:chain|chained)[\s\S]*(?:RPC|schema)/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a default sub-router rejects unchained middleware mutations", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-unchained-subrouter-middleware-`);

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/admin.ts`,
    [
      'import { Hono } from "hono";',
      "const admin = new Hono();",
      'admin.use("*", async (_c, next) => { await next(); });',
      "export default admin;",
      "",
    ].join("\n"),
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*app\/routes\/admin\.ts[\s\S]*(?:chain|chained)[\s\S]*(?:RPC|schema)/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a named method export must be a handler tuple", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-invalid-handler-export-`);

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/health.ts`,
    "export const GET = (c: any) => c.json({ ok: true });\n",
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*app\/routes\/health\.ts[\s\S]*GET[\s\S]*defineHandler[\s\S]*tuple/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a supported method function declaration is rejected instead of silently ignored", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-method-function-export-`);

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/health.ts`,
    "export function GET(c: any) { return c.json({ ok: true }); }\n",
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*app\/routes\/health\.ts[\s\S]*GET[\s\S]*defineHandler[\s\S]*tuple/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("an external method re-export is rejected when its handler tuple cannot be proven", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-method-reexport-`);

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/_handler.ts`,
    "export function GET(c: any) { return c.json({ ok: true }); }\n",
  );
  await writeFile(`${root}/app/routes/health.ts`, 'export { GET } from "./_handler.ts";\n');

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*app\/routes\/health\.ts[\s\S]*GET[\s\S]*defineHandler[\s\S]*tuple/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a named method cannot export an empty handler tuple", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-empty-handler-export-`);

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/health.ts`,
    [
      `import { defineHandler } from ${JSON.stringify(
        fileURLToPath(new URL("../src/app.ts", import.meta.url)),
      )};`,
      "export const GET = defineHandler();",
      "",
    ].join("\n"),
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*app\/routes\/health\.ts[\s\S]*GET[\s\S]*defineHandler[\s\S]*tuple/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a named method tuple rejects values that cannot be handlers", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-invalid-handler-value-`);

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(`${root}/app/routes/health.js`, "export const GET = [42];\n");

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*app\/routes\/health\.js[\s\S]*GET[\s\S]*(?:handler|tuple)/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a route syntax error reports the source file with Daroyan context", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-route-syntax-error-`);

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/health.ts`,
    "export const GET = [((c: any) => c.json({ ok: true })];\n",
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*(?:parse|syntax)[\s\S]*app\/routes\/health\.ts|app\/routes\/health\.ts[\s\S]*(?:parse|syntax)/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a route file with no supported method exports is ignored with a warning", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-empty-route-`);
  const warnings: string[] = [];
  const logger = createLogger("silent");
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(`${root}/app/routes/helpers.ts`, "export const answer = 42;\n");

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      "serve",
    );

    expect(warnings.join("\n")).toMatch(
      /\[daroyan\][\s\S]*app\/routes\/helpers\.ts[\s\S]*no supported method[\s\S]*GET/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("directory middleware around a default sub-router warns about its RPC boundary", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-subrouter-middleware-warning-`);
  const warnings: string[] = [];
  const logger = createLogger("silent");
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/app/routes/admin`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/admin/_middleware.ts`,
    [
      `import { defineMiddleware } from ${JSON.stringify(
        fileURLToPath(new URL("../src/app.ts", import.meta.url)),
      )};`,
      "export default defineMiddleware(async (_c, next) => { await next(); });",
      "",
    ].join("\n"),
  );
  await writeFile(
    `${root}/app/routes/admin/index.ts`,
    [
      'import { Hono } from "hono";',
      'export default new Hono().get("/", (c) => c.json({ admin: true }));',
      "",
    ].join("\n"),
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      "serve",
    );

    expect(warnings.join("\n")).toMatch(
      /\[daroyan\][\s\S]*app\/routes\/admin\/index\.ts[\s\S]*directory middleware[\s\S]*RPC[\s\S]*response/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("base-app early-response middleware warns about file-route RPC contracts", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-base-middleware-warning-`);
  const warnings: string[] = [];
  const logger = createLogger("silent");
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(
    `${root}/app/app.ts`,
    [
      `import { defineApp } from ${JSON.stringify(
        fileURLToPath(new URL("../src/app.ts", import.meta.url)),
      )};`,
      "const app = defineApp();",
      'app.use("*", (c) => c.json({ error: "UNAUTHORIZED" }, 401));',
      "export default app;",
      "",
    ].join("\n"),
  );
  await writeFile(
    `${root}/app/routes/index.ts`,
    "export const GET = [(c: any) => c.json({ ok: true })] as const;\n",
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      "serve",
    );

    expect(warnings.join("\n")).toMatch(
      /\[daroyan\][\s\S]*app\/app\.ts[\s\S]*base-app middleware[\s\S]*RPC[\s\S]*response/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a provable parameter schema and filename mismatch emits a warning", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-param-schema-warning-`);
  const warnings: string[] = [];
  const logger = createLogger("silent");
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/app/routes/users`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/users/$id.ts`,
    [
      'import { zValidator } from "@hono/zod-validator";',
      'import { z } from "zod";',
      "export const GET = [",
      '  zValidator("param", z.object({ userId: z.string() })),',
      '  (c: any) => c.json({ userId: c.req.valid("param").userId }),',
      "] as const;",
      "",
    ].join("\n"),
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      "serve",
    );

    expect(warnings.join("\n")).toMatch(
      /\[daroyan\][\s\S]*app\/routes\/users\/\$id\.ts[\s\S]*parameter schema[\s\S]*userId[\s\S]*id/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a parameter schema mismatch is detected through a method export list", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-exported-param-schema-warning-`);
  const warnings: string[] = [];
  const logger = createLogger("silent");
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/app/routes/users`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/users/$id.ts`,
    [
      'import { zValidator } from "@hono/zod-validator";',
      'import { z } from "zod";',
      "const handler = [",
      '  zValidator("param", z.object({ userId: z.string() })),',
      '  (c: any) => c.json({ userId: c.req.valid("param").userId }),',
      "] as const;",
      "export { handler as GET };",
      "",
    ].join("\n"),
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      "serve",
    );

    expect(warnings.join("\n")).toMatch(
      /\[daroyan\][\s\S]*app\/routes\/users\/\$id\.ts[\s\S]*parameter schema[\s\S]*userId[\s\S]*id/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a parameter schema mismatch is detected through a local schema variable", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-local-param-schema-warning-`);
  const warnings: string[] = [];
  const logger = createLogger("silent");
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/app/routes/users`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/users/$id.ts`,
    [
      'import { zValidator } from "@hono/zod-validator";',
      'import { z } from "zod";',
      "const params = z.object({ userId: z.string() });",
      "export const GET = [",
      '  zValidator("param", params),',
      '  (c: any) => c.json({ userId: c.req.valid("param").userId }),',
      "] as const;",
      "",
    ].join("\n"),
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      "serve",
    );

    expect(warnings.join("\n")).toMatch(
      /\[daroyan\][\s\S]*app\/routes\/users\/\$id\.ts[\s\S]*parameter schema[\s\S]*userId[\s\S]*id/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a production build with no server entry fails before bundling with guidance", async () => {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const root = await mkdtemp(`${packageRoot}/.daroyan-missing-entry-`);

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);

  try {
    await expect(
      build({
        configFile: false,
        logLevel: "silent",
        plugins: [daroyan()],
        root,
      }),
    ).rejects.toThrow(/\[daroyan\][\s\S]*server entry[\s\S]*app\/server\.ts[\s\S]*entry:/i);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("an incompatible TypeScript config receives a copy-pasteable correction", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-invalid-tsconfig-`);
  const warnings: string[] = [];
  const logger = createLogger("silent");
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/tsconfig.json`,
    JSON.stringify({ compilerOptions: { strict: false }, include: ["app"] }),
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      "serve",
    );

    expect(warnings.join("\n")).toMatch(
      /\[daroyan\][\s\S]*tsconfig\.json[\s\S]*"strict": true[\s\S]*"module": "ESNext"[\s\S]*"moduleResolution": "Bundler"[\s\S]*"rootDirs"[\s\S]*\.daroyan\/types[\s\S]*\.daroyan\/\*\*\/\*\.d\.ts/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a missing TypeScript config receives the generated-types configuration", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-missing-tsconfig-`);
  const warnings: string[] = [];
  const logger = createLogger("silent");
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      "serve",
    );

    expect(warnings.join("\n")).toMatch(
      /\[daroyan\][\s\S]*tsconfig\.json[\s\S]*missing[\s\S]*"strict": true[\s\S]*"rootDirs"[\s\S]*\.daroyan\/types[\s\S]*include/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("TypeScript settings inherited from a relative config are accepted", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-extended-tsconfig-`);
  const warnings: string[] = [];
  const logger = createLogger("silent");
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/tsconfig.base.json`,
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
      },
    }),
  );
  await writeFile(
    `${root}/tsconfig.json`,
    JSON.stringify({
      extends: "./tsconfig.base.json",
      compilerOptions: {
        rootDirs: [".", "./.daroyan/types"],
      },
      include: ["app", ".daroyan/**/*.d.ts"],
    }),
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      "serve",
    );

    expect(warnings).toEqual([]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("TypeScript settings inherited from a package config are accepted", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-package-tsconfig-`);
  const warnings: string[] = [];
  const logger = createLogger("silent");
  logger.warn = (message) => {
    warnings.push(message);
  };

  await mkdir(`${root}/app/routes`, { recursive: true });
  await mkdir(`${root}/node_modules/@example/tsconfig`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/node_modules/@example/tsconfig/package.json`,
    JSON.stringify({
      name: "@example/tsconfig",
      exports: "./tsconfig.json",
    }),
  );
  await writeFile(
    `${root}/node_modules/@example/tsconfig/tsconfig.json`,
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
      },
    }),
  );
  await writeFile(
    `${root}/tsconfig.json`,
    JSON.stringify({
      extends: "@example/tsconfig",
      compilerOptions: {
        rootDirs: [".", "./.daroyan/types"],
      },
      include: ["app", ".daroyan/**/*.d.ts"],
    }),
  );

  try {
    await resolveConfig(
      { configFile: false, customLogger: logger, plugins: [daroyan()], root },
      "serve",
    );

    expect(warnings).toEqual([]);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("_middleware.js is discovered for JavaScript route projects", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-js-middleware-`);

  await mkdir(`${root}/app/routes/api`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/api/_middleware.js`,
    "export default [(c, next) => next()];\n",
  );
  await writeFile(
    `${root}/app/routes/api/index.js`,
    "export const GET = [(c) => c.json({ ok: true })];\n",
  );

  try {
    await resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve");
    const manifest = JSON.parse(await readFile(`${root}/.daroyan/manifest.json`, "utf8")) as {
      routes: Array<{ middleware: string[]; path: string }>;
    };

    expect(manifest.routes).toContainEqual(
      expect.objectContaining({
        middleware: ["app/routes/api/_middleware.js"],
        path: "/api",
      }),
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("directory middleware must default-export a middleware tuple", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-invalid-middleware-`);

  await mkdir(`${root}/app/routes/api`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/api/_middleware.ts`,
    "export default async function middleware(_c: any, next: () => Promise<void>) { await next(); }\n",
  );
  await writeFile(
    `${root}/app/routes/api/index.ts`,
    "export const GET = [(c: any) => c.json({ ok: true })] as const;\n",
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*app\/routes\/api\/_middleware\.ts[\s\S]*default[\s\S]*defineMiddleware[\s\S]*tuple/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("directory middleware cannot export an empty middleware tuple", async () => {
  const root = await mkdtemp(`${tmpdir()}/daroyan-empty-middleware-`);
  await mkdir(`${root}/app/routes/api`, { recursive: true });
  await writeFile(`${root}/app/app.ts`, temporaryAppSource);
  await writeFile(
    `${root}/app/routes/api/_middleware.ts`,
    [
      `import { defineMiddleware } from ${JSON.stringify(
        fileURLToPath(new URL("../src/app.ts", import.meta.url)),
      )};`,
      "export default defineMiddleware();",
      "",
    ].join("\n"),
  );
  await writeFile(
    `${root}/app/routes/api/index.ts`,
    "export const GET = [(c: any) => c.json({ ok: true })] as const;\n",
  );

  try {
    await expect(
      resolveConfig({ configFile: false, plugins: [daroyan()], root }, "serve"),
    ).rejects.toThrow(
      /\[daroyan\][\s\S]*app\/routes\/api\/_middleware\.ts[\s\S]*(?:one|non-empty)[\s\S]*middleware/i,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});
