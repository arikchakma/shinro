# Daroyan

Type-safe file routing and Hono RPC for Node.js and Bun servers.

Daroyan discovers route modules through one Vite plugin, mounts them onto
your own Hono instance, and generates a typed Hono client. The application
still owns startup, the listener, signals, and graceful shutdown.

## Install

```sh
vp add hono
vp add -D daroyan
```

For Node.js:

```sh
vp add @hono/node-server
```

Bun can use `Bun.serve()` directly.

## Configure

```ts
// vite.config.ts
import { daroyan } from "daroyan";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [daroyan()],
});
```

Daroyan is the only routing integration. There is no Node plugin, Bun
plugin, RPC plugin, or lifecycle plugin.

Generated companions use `rootDirs`. Include the generated declaration
tree so the app environment is available in every route:

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "strict": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "rootDirs": [".", "./.daroyan/types"],
  },
  "include": ["app", ".daroyan/**/*.d.ts"],
}
```

Ignore generated and build output:

```gitignore
.daroyan/
dist/
```

## Create the app

```ts
// app/app.ts
import { logger } from "hono/logger";
import { defineApp } from "daroyan/app";

export type AppEnv = {
  Variables: {
    requestId: string;
  };
};

const app = defineApp<AppEnv>();

// This is a normal Hono instance.
app.use("*", logger());
app.onError((error, c) => {
  console.error(error);
  return c.json({ error: "INTERNAL_ERROR" as const }, 500);
});

export default app;
```

Declare the environment once on `defineApp<AppEnv>()`. Generated
`.daroyan/daroyan.d.ts` binds `defineHandler()` and
`defineMiddleware()` to it throughout the project.

Daroyan deliberately exposes no `onStart`, `onShutdown`, or server wrapper
API.

## Add routes

```ts
// app/routes/health.ts
import { defineHandler } from "daroyan/app";

export const GET = defineHandler((c) => {
  return c.json({ ok: true as const }, 200);
});
```

One file can handle multiple methods:

```ts
// app/routes/api/users.ts
import { zValidator } from "@hono/zod-validator";
import { defineHandler } from "daroyan/app";
import { z } from "zod";

const input = z.object({
  name: z.string().min(1),
});

export const GET = defineHandler(async (c) => {
  return c.json({ users: [] }, 200);
});

export const POST = defineHandler(zValidator("json", input), async (c) => {
  const user = c.req.valid("json");
  return c.json({ user }, 201);
});
```

Supported named exports are `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, and
`OPTIONS`. A matching `GET` also handles `HEAD` through Hono.

### File-to-URL mapping

| File                            | URL                |
| ------------------------------- | ------------------ |
| `app/routes/index.ts`           | `/`                |
| `app/routes/health.ts`          | `/health`          |
| `app/routes/api/users.ts`       | `/api/users`       |
| `app/routes/api/users/index.ts` | `/api/users`       |
| `app/routes/api/users/$id.ts`   | `/api/users/:id`   |
| `app/routes/files/$...path.ts`  | `/files/:path{.+}` |

Catch-all parameters match one or more segments. Static routes register
before dynamic routes, which register before catch-alls.

Files beginning with `_` or `.`, declaration files, test/spec files, and
files under `__tests__`, `__fixtures__`, `.dot-directories`, or `+types`
are not routes.

Additional files can be excluded with route-relative
[minimatch](https://www.npmjs.com/package/minimatch) globs. A match
excludes both route modules and directory middleware:

```ts
daroyan({
  ignoredRouteFiles: ["internal/**", "**/*.draft.ts"],
});
```

Supported method values must be local `defineHandler()` tuples. Daroyan
rejects method-named function/class declarations and external method
re-exports early instead of allowing a later spread failure.

## Directory middleware

`_middleware.ts` applies to the route at its directory URL and every
descendant. It can export multiple middleware handlers:

```ts
// app/routes/api/_middleware.ts
import { defineMiddleware } from "daroyan/app";
import type { Route } from "./+types/_middleware";

export default defineMiddleware<Route.Middleware>(
  async (c, next) => {
    c.header("x-api-version", "1");
    await next();
  },
  async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    await next();
  },
);
```

For `/api/users`, middleware stacks from the route root toward the leaf:

```text
app/routes/_middleware.ts
app/routes/api/_middleware.ts
app/routes/api/users.ts
```

Daroyan flattens this chain onto named routes. Typed early responses from
directory middleware, such as a `401`, therefore enter that route's RPC
response union.

Route-local middleware and validators go directly in `defineHandler()`:

```ts
export const POST = defineHandler(requireUser, zValidator("json", input), async (c) => {
  return c.json({ user: c.req.valid("json") }, 201);
});
```

## Parameters and optional companions

Routes do not need generated imports. For runtime-validated input, prefer a
Hono validator:

```ts
// app/routes/users/$id.ts
const params = z.object({ id: z.string().min(1) });

export const GET = defineHandler(zValidator("param", params), (c) => {
  const { id } = c.req.valid("param");
  return c.json({ id }, 200);
});
```

Daroyan also generates an optional filename companion:

```ts
import { defineHandler } from "daroyan/app";
import type { Route } from "./+types/$id";

export const GET = defineHandler<Route.Handler>((c) => {
  const id = c.req.param("id");
  return c.json({ id }, 200);
});
```

The companion supplies the filename-derived path and parameter names. It
does not validate requests at runtime; use `zValidator` when validation is
required. Supplying the explicit `Route.Handler` generic can widen response
and status inference because TypeScript does not partially infer later
generic parameters after an explicit one.

## Chained sub-routers and manual routes

A route file can default-export a chained Hono sub-router:

```ts
// app/routes/admin.ts
import { Hono } from "hono";

export default new Hono()
  .get("/", (c) => c.json({ section: "admin" }, 200))
  .get("/stats", (c) => c.json({ activeUsers: 42 }, 200));
```

This creates `/admin` and `/admin/stats`, including both in the generated
client. The file owns the complete `/admin` namespace, so it cannot coexist
with `app/routes/admin/**` or a dynamic file route that can match beneath
that namespace.

Manual routes are also valid:

```ts
const app = defineApp().get("/manual", (c) => {
  return c.json({ manual: true as const }, 200);
});
```

Retaining the Hono chain as above includes `/manual` in RPC. An unassigned
mutation such as `app.get("/manual", handler)` still runs, but Hono does not
retain that schema in `typeof app`, so it cannot enter the client type.

## RPC client

Daroyan generates `.daroyan/client.ts`:

```ts
import { createClient } from "./.daroyan/client";

const api = createClient("http://localhost:3000");

const response = await api.api.users.$post({
  json: {
    name: "Ada",
  },
});

if (response.status === 201) {
  const body = await response.json();
}
```

Dynamic parameters use Hono RPC syntax:

```ts
await api.users[":id"].$get({
  param: {
    id: "usr_123",
  },
});
```

An API workspace can publish its generated types:

```jsonc
{
  "exports": {
    "./client": "./.daroyan/client.ts",
    "./rpc": "./.daroyan/rpc.ts",
  },
}
```

Set `rpc.enabled` to `false` when the project does not need generated RPC
or entry declarations.

## Own the server lifecycle

Node example:

```ts
// app/server.ts
import { serve } from "@hono/node-server";
import app from "daroyan/entry";

const server = serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 3000),
});

process.once("SIGTERM", () => {
  server.close();
});
```

Bun example:

```ts
// app/server.ts
import app from "daroyan/entry";

const server = Bun.serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 3000),
});

process.once("SIGTERM", () => {
  void server.stop(false);
});
```

These are application decisions. Daroyan imports the configured entry
during development and bundles that exact entry for production; it never
creates or hides the native server.

## Development, type generation, and build

```sh
vp dev
daroyan typegen
vp build
```

`daroyan typegen` refreshes `.daroyan` without starting the application
listener, which makes clean-checkout `tsc --noEmit` workflows possible.

The default production artifact is:

```text
dist/server.mjs
```

Ordinary JavaScript dependencies are bundled into this file. Node built-ins
remain native. Extra JavaScript chunks are an error; emitted runtime assets
produce a warning. Native addons, migrations, templates, files opened at
runtime, and external WASM remain application deployment concerns.

## Options

```ts
daroyan({
  app: "app/app.ts",
  entry: "app/server.ts",
  routes: "app/routes",
  basePath: "/",
  build: {
    outDir: "dist",
    fileName: "server.mjs",
    minify: false,
    sourcemap: false,
  },
  rpc: {
    enabled: true,
    outDir: ".daroyan",
  },
});
```

There are intentionally no runtime, port, hostname, startup, signal, or
shutdown options.

v0.1 supports one `daroyan()` plugin instance per TypeScript project.
Separate applications in a monorepo use separate Vite configurations and
TypeScript programs.

See the repository `SPEC.md` for the complete v0.1 contract, diagnostics,
and test requirements.
