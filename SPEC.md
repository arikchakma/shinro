# Daroyan specification

Status: proposal for refinement  
Target: v0.1  
Package name: `daroyan`

> Daroyan is a file-based routing framework for Hono applications running
> on Node.js or Bun. One Vite plugin discovers routes, mounts them onto a
> normal Hono instance, generates optional route types and an end-to-end
> typed RPC client, and bundles the user's server entry.

## 1. Confirmed API direction

The central API is intentionally small:

```ts
// app/app.ts
import { logger } from "hono/logger";
import { defineApp } from "daroyan/app";

const app = defineApp();

app.use("*", logger());

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: "INTERNAL_ERROR" as const }, 500);
});

app.notFound((c) => {
  return c.json({ error: "NOT_FOUND" as const }, 404);
});

export default app;
```

`defineApp()` returns a real Hono instance. The user may call any Hono API
on it and exports that instance as the default export.

Daroyan does not define application startup or shutdown APIs. It does not
register signal handlers, close databases, drain queues, call
`process.exit()`, or hide the native server handle. Those responsibilities
belong to the user's server entry:

```ts
// app/server.ts
import { serve } from "@hono/node-server";

import app from "daroyan/entry";
import { shutdown } from "./shutdown";
import { initDatabase } from "./lib/db";
import { initRedis } from "./lib/redis";

await Promise.all([initDatabase(), initRedis()]);

const server = serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 3000),
});

process.once("SIGINT", () => shutdown(server, "SIGINT"));
process.once("SIGTERM", () => shutdown(server, "SIGTERM"));
```

Routes are equally small:

```ts
// app/routes/health.ts
import { defineHandler } from "daroyan/app";

export const GET = defineHandler((c) => {
  return c.json({ ok: true }, 200);
});
```

Generated `+types` are available but optional:

```ts
// app/routes/users/$id.ts
import { defineHandler } from "daroyan/app";
import type { Route } from "./+types/$id";

export const GET = defineHandler<Route>((c) => {
  return c.json({ id: c.req.param("id") }, 200);
});
```

The minimal and strict forms produce the same runtime route and RPC
contract. The generated type only improves server-side filename-derived
typing.

## 2. Meaning of “single”

“Single” has three meanings in this specification:

1. The only Vite integration is `plugins: [daroyan()]`. The user does not
   install separate route, RPC, development, Node, or Bun plugins.
2. One route file contains all HTTP methods for its endpoint. The user does
   not create separate `get.ts`, `post.ts`, and `delete.ts` files.
3. Daroyan bundles the configured server entry to one JavaScript entry file
   by default. The contents and runtime behavior of that entry remain
   user-owned.

Daroyan is still file-based, so a real application normally contains many
route files.

## 3. Name and vocabulary

“Daroyan” means doorman or gatekeeper in Bengali. The framework directs
incoming requests to the correct file without taking ownership of the
application or its process.

| Concept                        | Public name          |
| ------------------------------ | -------------------- |
| Framework package              | `daroyan`            |
| Vite plugin                    | `daroyan()`          |
| Hono app factory               | `defineApp()`        |
| Route handler helper           | `defineHandler()`    |
| Directory middleware helper    | `defineMiddleware()` |
| Generated assembled app        | `daroyan/entry`      |
| Generated RPC application type | `AppType`            |
| Generated client factory       | `createClient()`     |
| Generated working directory    | `.daroyan/`          |
| Log prefix                     | `[daroyan]`          |

The names intentionally resemble Kumoh, while the process model is better
suited to long-running Node.js and Bun servers.

## 4. Design principles

### 4.1 Daroyan owns

- route discovery and conflict detection;
- deterministic middleware and route registration;
- mounting discovered routes onto the user's Hono instance;
- generated optional route and middleware companion types;
- reconstructing the Hono RPC type;
- generating a precomputed Hono client;
- Vite development integration and structural route reloads;
- bundling the configured server entry.

### 4.2 The user owns

- the Hono instance after `defineApp()` returns it;
- global middleware, `onError`, `notFound`, and manual Hono configuration;
- application initialization;
- Node.js or Bun adapter selection;
- listener creation and the native listener handle;
- signal handling;
- graceful request draining;
- database, cache, worker, and other resource cleanup;
- process exit behavior;
- runtime-specific server options such as TLS, HTTP/2, and WebSockets.

Daroyan must not introduce lifecycle hooks such as `onStart`,
`onShutdown`, `startup`, or `shutdown`.

## 5. Goals

- Add file-based routing to a Hono server with one Vite plugin.
- Preserve the normal Hono programming model.
- Avoid required per-route generated imports or duplicated path strings.
- Allow stricter filename-derived route types when a project wants them.
- Support explicit runtime validation through normal Hono validators.
- Generate an end-to-end typed Hono RPC client.
- Support user-owned Node.js and Bun server entries.
- Make adding, removing, or renaming route files update development routing
  and RPC types.
- Keep runtime route registration and RPC route registration derived from
  one normalized manifest.
- Fail clearly on conflicting or invalid route files.

## 6. Non-goals for v0.1

- Owning startup or graceful shutdown.
- Abstracting the Node.js or Bun native server handle.
- Automatically provisioning infrastructure.
- Front-end rendering or full-stack framework conventions.
- Choosing a schema library for the user.
- OpenAPI generation.
- Deployment orchestration.
- Automatically publishing a generated RPC client to npm.
- Route groups, layouts, or optional filename segments.
- Making arbitrary external assets or native addons part of the
  single-entry bundle.

## 7. Installation

```sh
vp add hono
vp add -D daroyan
```

Node.js applications install Hono's Node adapter:

```sh
vp add @hono/node-server
```

Bun applications can use `Bun.serve()` directly.

## 8. Vite configuration

```ts
// vite.config.ts
import { daroyan } from "daroyan";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [daroyan()],
});
```

Conceptual options:

```ts
export type DaroyanOptions = {
  app?: string;
  entry?: string;
  routes?: string;
  basePath?: `/${string}` | "/";
  build?: {
    outDir?: string;
    fileName?: `${string}.mjs`;
    minify?: boolean;
    sourcemap?: false | "inline";
  };
  rpc?: {
    enabled?: boolean;
    outDir?: string;
  };
};

export function daroyan(options?: DaroyanOptions): Plugin;
```

Defaults:

```ts
const defaults = {
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
} satisfies DaroyanOptions;
```

There are deliberately no `runtime`, `serve`, `port`, `hostname`, signal,
or shutdown options. Those configure the user's server, not routing.

## 9. TypeScript configuration

Generated companion types use TypeScript's `rootDirs` support:

```jsonc
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

This lets a route optionally import:

```ts
import type { Route } from "./+types/$id";
```

without writing generated files into `app/routes`.

Daroyan keeps the project environment binding in
`.daroyan/daroyan.d.ts`. The TypeScript include above guarantees that
editors and standalone `tsc` load the project-specific `daroyan/app`
augmentation without requiring an import in every route.

Projects should ignore:

```gitignore
.daroyan/
dist/
```

The plugin validates the important TypeScript settings and provides a
copy-pasteable correction when they are missing.

## 10. Default project layout

```text
.
├── app/
│   ├── app.ts
│   ├── server.ts
│   ├── shutdown.ts
│   └── routes/
│       ├── index.ts
│       ├── health.ts
│       └── api/
│           ├── _middleware.ts
│           └── users/
│               ├── index.ts
│               └── $id.ts
├── .daroyan/
│   ├── client.ts
│   ├── daroyan.d.ts
│   ├── manifest.json
│   ├── rpc.ts
│   └── types/
├── dist/
│   └── server.mjs
├── package.json
├── tsconfig.json
└── vite.config.ts
```

`app/app.ts` and `app/routes` are required. `app/server.ts` is required for
development and production builds, but not for route scanning or RPC-only
type generation.

`shutdown.ts` is an example of user code, not a Daroyan convention.

## 11. The application module

### 11.1 `defineApp()`

Conceptual signature:

```ts
import type { Env, HonoOptions } from "hono";
import { Hono } from "hono";

export function defineApp<E extends Env = Env>(options?: HonoOptions<E>): Hono<E>;
```

It is effectively a correctly configured Hono constructor:

```ts
const app = defineApp();
```

or, when the application has an explicit Hono environment:

```ts
type AppEnv = {
  Variables: {
    requestId: string;
    user: User;
  };
};

const app = defineApp<AppEnv>();
```

The return value is a normal Hono instance:

```ts
app.use("*", middleware);
app.get("/manual", handler);
app.route("/legacy", legacyRouter);
app.onError(errorHandler);
app.notFound(notFoundHandler);
app.request("/health");
app.fetch(request);
```

There is no callback, descriptor, or second generic:

```ts
// Not part of the API
defineApp((app) => {});
defineApp<AppEnv, RpcResponses>((app) => {});
defineServer({ app });
```

### 11.2 App export contract

The configured app module must default-export the Hono instance:

```ts
// app/app.ts
import { defineApp } from "daroyan/app";

const app = defineApp();

// Any normal Hono configuration can go here.

export default app;
```

Daroyan's generated application wrapper imports this instance, registers
directory middleware and routes, and exports the assembled instance through
`daroyan/entry`.

The user's app module contains no generated imports and does not manually
mount file routes.

### 11.3 Manual routes

Manual Hono routes are allowed:

```ts
const app = defineApp().get("/manual", (c) => {
  return c.json({ manual: true }, 200);
});
```

File routes remain the recommended public API surface. Daroyan can include
manual routes in the RPC contract only when Hono has retained their schema,
which requires chaining and assigning the result as shown above.

Routes added later through unassigned mutation:

```ts
const app = defineApp();
app.get("/manual", handler);
```

work at runtime, but Hono's `typeof app` does not retain that route schema.
Daroyan must not claim RPC typing for those manual routes.

## 12. File-to-URL convention

Daroyan scans `app/routes/**/*.{ts,js}` by default.

| Route file                         | URL                   |
| ---------------------------------- | --------------------- |
| `app/routes/index.ts`              | `/`                   |
| `app/routes/health.ts`             | `/health`             |
| `app/routes/api/users.ts`          | `/api/users`          |
| `app/routes/api/users/index.ts`    | `/api/users`          |
| `app/routes/api/users/$id.ts`      | `/api/users/:id`      |
| `app/routes/api/$version/users.ts` | `/api/:version/users` |
| `app/routes/files/$...path.ts`     | `/files/:path{.+}`    |

Rules:

- `index` contributes no URL segment.
- `$name` becomes the required Hono parameter `:name`.
- `$...name` becomes the one-or-more catch-all `:name{.+}`.
- Dynamic directories follow the same rules as dynamic files.
- Catch-all segments must be final.
- Generated RPC URLs are canonicalized without trailing slashes, except
  `/`.

Ignored files:

- `_middleware.ts`, except for its reserved middleware role;
- any other basename beginning with `_`;
- dotfiles;
- `*.d.ts`;
- `*.test.*` and `*.spec.*`;
- files under `__tests__`, `__fixtures__`, or `+types`.

### 12.1 Conflicts

These files conflict because they produce the same URL:

```text
app/routes/users.ts
app/routes/users/index.ts
```

These files also conflict because their matching shape is equivalent:

```text
app/routes/users/$id.ts
app/routes/users/$slug.ts
```

Daroyan reports both source files and the normalized route, then fails
generation and build.

## 13. Route module API

A route module can export:

- `GET`
- `POST`
- `PUT`
- `PATCH`
- `DELETE`
- `OPTIONS`

`HEAD` is not a separate export in v0.1. Hono handles `HEAD` through the
matching `GET` route and removes the response body.

One file may export multiple methods:

```ts
// app/routes/api/users/index.ts
import { zValidator } from "@hono/zod-validator";
import { defineHandler } from "daroyan/app";
import { z } from "zod";

const createUser = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});

export const GET = defineHandler(async (c) => {
  const users = await listUsers();
  return c.json({ users }, 200);
});

export const POST = defineHandler(zValidator("json", createUser), async (c) => {
  const user = await insertUser(c.req.valid("json"));
  return c.json({ user }, 201);
});
```

`defineHandler()` accepts zero or more Hono middleware handlers followed by
the final handler, matching Hono's factory helper.

It is a typed identity/factory helper. The callback receives an ordinary
Hono `Context`, and every Hono response helper remains available.

## 14. Optional generated route types

Daroyan generates a type-only companion for every route. Importing it is
optional.

### 14.1 Minimal form

```ts
// app/routes/api/users/$id.ts
import { defineHandler } from "daroyan/app";

export const GET = defineHandler((c) => {
  return c.json({ id: c.req.param("id") }, 200);
});
```

This form still provides:

- the project-level Hono environment;
- middleware and validator inference;
- response body and status inference;
- the generated RPC route and client parameter;
- normal Hono parameter access.

It does not provide exact filename-derived parameter-key checking inside
`c.req.param()`.

### 14.2 Strict filename-derived form

```ts
// app/routes/api/users/$id.ts
import { defineHandler } from "daroyan/app";
import type { Route } from "./+types/$id";

export const GET = defineHandler<Route>((c) => {
  const id = c.req.param("id");

  // TypeScript error: "userId" is not a parameter in $id.ts.
  // c.req.param("userId");

  return c.json({ id }, 200);
});
```

The companion is conceptually:

```ts
export type Route = DaroyanRoute<{
  path: "/api/users/:id";
  params: {
    id: string;
  };
  env: AppEnv;
}>;
```

Supported call forms:

```ts
defineHandler(handler);
defineHandler(middleware, handler);

defineHandler<Route>(handler);
defineHandler<Route>(middleware, handler);
```

The generated generic changes types only. It does not register the route,
add validation, or change runtime behavior.

### 14.3 Recommended parameter validation

For production inputs, `zValidator("param", schema)` is the recommended
approach because it supplies both runtime validation and typed access:

```ts
// app/routes/api/users/$id.ts
import { zValidator } from "@hono/zod-validator";
import { defineHandler } from "daroyan/app";
import { z } from "zod";

const params = z.object({
  id: z.string().min(1),
});

export const GET = defineHandler(zValidator("param", params), async (c) => {
  const { id } = c.req.valid("param");
  return c.json({ id }, 200);
});
```

The validator makes `c.req.valid("param")` exact and rejects invalid
requests at runtime. For many routes, this removes any reason to import the
generated `Route` type.

The two features can be combined:

```ts
import type { Route } from "./+types/$id";

export const GET = defineHandler<Route>(zValidator("param", params), async (c) => {
  const { id } = c.req.valid("param");
  return c.json({ id }, 200);
});
```

Use:

- a validator when input must be checked at runtime;
- `Route` when exact filename-derived `c.req.param()` keys are useful;
- both when a team wants both guarantees;
- neither for a low-ceremony route that accepts normal Hono typing.

`+types` must never be required for route discovery, runtime registration,
builds, or RPC generation.

## 15. Advanced default sub-router

A route module may default-export a chained Hono sub-router:

```ts
// app/routes/admin.ts
import { Hono } from "hono";

const admin = new Hono()
  .get("/", (c) => c.json({ section: "admin" }, 200))
  .get("/stats", (c) => c.json({ activeUsers: 42 }, 200));

export default admin;
```

This mounts at `/admin`, producing `/admin` and `/admin/stats`.

Requirements:

- handlers must be chained to retain Hono's RPC schema;
- a module cannot mix a default sub-router and uppercase method exports;
- the default sub-router is imported by both assemblers and mounted with
  `.route("/admin", admin)`;
- a default sub-router owns its complete mount namespace, so
  `app/routes/admin.ts` cannot coexist with files under
  `app/routes/admin/**`;
- named HTTP exports are the primary convention;
- filename companion types do not describe paths declared inside the
  sub-router because Hono already types those inline paths.

Owning the complete namespace prevents an opaque route declared inside the
sub-router from silently colliding with a descendant file route.

## 16. Middleware

### 16.1 Route-local middleware

Pass route-local middleware directly to `defineHandler()`:

```ts
export const POST = defineHandler(requireUser, zValidator("json", inputSchema), async (c) => {
  const input = c.req.valid("json");
  return c.json({ created: true, input }, 201);
});
```

Validators should normally be route-local so their inferred inputs become
part of the Hono RPC contract.

### 16.2 Directory middleware

`_middleware.ts` applies to every route in its directory and descendants:

```ts
// app/routes/api/_middleware.ts
import { defineMiddleware } from "daroyan/app";

export default defineMiddleware(
  async (c, next) => {
    c.header("x-api-version", "1");
    await next();
  },
  async (c, next) => {
    c.set("requestStartedAt", Date.now());
    await next();
  },
);
```

`defineMiddleware()` is variadic. It accepts one or more ordinary Hono
middleware handlers and returns a typed middleware bundle:

```ts
defineMiddleware(middleware);
defineMiddleware(middlewareA, middlewareB, middlewareC);

defineMiddleware<Middleware>(middleware);
defineMiddleware<Middleware>(middlewareA, middlewareB);
```

The bundle preserves the original tuple, including each middleware's input
and return type. It must not widen the result to `MiddlewareHandler[]`.
Daroyan spreads it during registration, so request-side code runs
left-to-right. Code after `await next()` unwinds right-to-left, following
normal Hono middleware behavior.

Existing bundles can be composed without a separate array API:

```ts
const security = defineMiddleware(cors(), secureHeaders());

export default defineMiddleware(...security, authenticate());
```

Generated middleware companion types are also optional:

```ts
import { defineMiddleware } from "daroyan/app";
import type { Middleware } from "./+types/_middleware";

export default defineMiddleware<Middleware>(requestId(), authenticate(), async (c, next) => {
  await next();
});
```

Middleware stacks root-to-leaf:

```text
app/routes/_middleware.ts
app/routes/api/_middleware.ts
app/routes/api/admin/_middleware.ts
```

A request under `/api/admin` runs them in that order. Child middleware
augments rather than replaces ancestor middleware, and each handler runs
once per request.

For named method routes, Daroyan flattens the applicable directory
middleware into that route's handler chain. Given a root middleware, an API
middleware, and `GET /api/users`, runtime registration is conceptually:

```ts
app.on("GET", "/api/users", ...rootMiddleware, ...apiMiddleware, ...usersGet);
```

Daroyan does not implement directory middleware by assuming a particular
Hono wildcard behavior. Flattening guarantees that middleware applies to
the route at the directory's own URL as well as its descendants. Because
conflicting route shapes are rejected, exactly one flattened route chain
handles a request and each inherited middleware runs once.

For a default sub-router, the runtime assembler creates an internal wrapper
sub-app so inherited middleware still applies once to the mount root and
all internal paths:

```ts
const mountedAdmin = new Hono<ProjectEnv>()
  .use("*", ...rootMiddleware, ...adminMiddleware)
  .route("/", admin);

app.route("/admin", mountedAdmin);
```

The wrapper is an implementation detail and is never imported by user
code.

Execution order:

1. middleware registered by the user on the app instance;
2. root `_middleware.ts`;
3. ancestor `_middleware.ts` files, shallow to deep;
4. route-local middleware;
5. final route handler.

The RPC generator uses the same flattened chain for named method routes.
Consequently, a typed early response from directory middleware, such as a
`401` authentication response, becomes part of that route's Hono RPC
response union.

```ts
// app/routes/api/_middleware.ts
export default defineMiddleware(async (c, next) => {
  const user = await authenticate(c.req.raw);

  if (!user) {
    return c.json({ error: "UNAUTHORIZED" as const }, 401);
  }

  c.set("user", user);
  await next();
});
```

```ts
const response = await api.api.users.$get();

if (response.status === 401) {
  const error = await response.json();
  // { error: "UNAUTHORIZED" }
}
```

Two boundaries remain:

- middleware manually registered on the base app is not reconstructable as
  part of every file route's response schema;
- a default-exported Hono sub-router retains its own RPC schema, but Daroyan
  cannot automatically add responses from surrounding directory
  middleware to every opaque internal route in v0.1.

Authors of default sub-routers should attach contract-relevant middleware
inside their chained sub-router when its early responses must appear in the
client. Daroyan does not introduce a required global response generic.

## 17. Environment typing

An explicit app environment is declared once:

```ts
// app/app.ts
import { defineApp } from "daroyan/app";

export type AppEnv = {
  Variables: {
    requestId: string;
    user: User;
  };
};

const app = defineApp<AppEnv>();

export default app;
```

Daroyan infers the environment from the default app export and generates
one project-level declaration that binds `defineHandler` and
`defineMiddleware` to it.

Route files do not repeat `AppEnv`:

```ts
import { defineHandler } from "daroyan/app";

export const GET = defineHandler((c) => {
  return c.json({
    requestId: c.var.requestId,
    userId: c.var.user.id,
  });
});
```

This project-level binding is independent of optional `+types`. A route
without a `Route` import still receives the configured environment.

The package declarations use a mergeable project marker rather than trying
to replace a generic default through module augmentation:

```ts
// Conceptual declarations shipped by daroyan/app
import type { Env, Hono } from "hono";

export interface DaroyanProject {}

type ProjectApp = DaroyanProject extends {
  readonly app: infer App;
}
  ? App
  : Hono;

export type ProjectEnv = ProjectApp extends Hono<infer E, any, any> ? E : Env;

export const defineHandler: DefineHandler<ProjectEnv>;
export const defineMiddleware: DefineMiddleware<ProjectEnv>;
```

Type generation writes this project-specific merge:

```ts
// .daroyan/daroyan.d.ts
import type app from "../app/app";

declare module "daroyan/app" {
  interface DaroyanProject {
    readonly app: typeof app;
  }
}
```

The generated declaration is loaded through the project's
`.daroyan/**/*.d.ts` TypeScript include. It is generated automatically by
the plugin and by `daroyan typegen`; users do not import or edit it.

The fallback before type generation is the ordinary Hono `Env`. After type
generation, failing to infer the environment from the configured app is a
type-generation error rather than silently requiring
`defineHandler<AppEnv>(...)`.

v0.1 supports one Daroyan application per TypeScript project. Separate
applications in a monorepo use separate `tsconfig.json` programs so their
`DaroyanProject` declarations cannot collide.

Daroyan does not normalize `process.env`, `Bun.env`, or runtime-specific
raw server bindings. Those remain application and adapter concerns.

## 18. Assembled application

`daroyan/entry` is the generated application entry:

```ts
import app from "daroyan/entry";
```

Conceptually, it:

1. imports the default Hono instance from `app/app.ts`;
2. imports directory middleware and route modules;
3. registers them in deterministic order;
4. exports the same app instance.

Conceptual exports:

```ts
declare const app: Hono;

export default app;
export { app };
export const fetch: typeof app.fetch;
export type AppType = /* generated RPC type */;
```

The entry module has no listener and performs no initialization or shutdown
behavior.

The user's server imports the assembled entry. Tests import the same module,
ensuring runtime and test route assembly cannot drift.

The public name follows Kumoh's `kumoh/entry` convention. Vite internally
resolves it to the private ID `\0daroyan/entry`; the private ID must never
appear in user code, generated source imports, errors, or documentation.

The package ships a fallback `daroyan/entry` declaration so TypeScript can
resolve the subpath before generation. `.daroyan/types/entry.d.ts` refines
that declaration to the current project's assembled `AppType`. The Vite
plugin must resolve the runtime import before normal package resolution.
Importing the package's runtime placeholder without the plugin throws an
actionable error instead of returning an unassembled app.

## 19. User-owned server entry

### 19.1 Node.js

```ts
// app/server.ts
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";

import app from "daroyan/entry";
import { closeDatabase, initDatabase } from "./lib/db";
import { closeRedis, initRedis } from "./lib/redis";

await Promise.all([initDatabase(), initRedis()]);

const server = serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 3000),
});

let stopping: Promise<void> | undefined;

function shutdown(server: ServerType, signal: string): Promise<void> {
  if (stopping) {
    return stopping;
  }

  stopping = (async () => {
    console.info(`${signal} received`);

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    await Promise.allSettled([closeDatabase(), closeRedis()]);
  })();

  return stopping;
}

process.once("SIGINT", () => {
  void shutdown(server, "SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown(server, "SIGTERM");
});
```

This is application code. Daroyan neither supplies nor calls `shutdown()`.

### 19.2 Bun

```ts
// app/server.ts
import app from "daroyan/entry";

import { closeDatabase, initDatabase } from "./lib/db";

await initDatabase();

const server = Bun.serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 3000),
});

async function shutdown(signal: string) {
  console.info(`${signal} received`);

  await server.stop(false);
  await closeDatabase();
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
```

The project chooses the appropriate Bun shutdown semantics and version
requirements. Daroyan does not wrap `Bun.Server`.

### 19.3 Runtime portability

An application may maintain separate Node and Bun entries or write one
entry with runtime detection. Daroyan does not force one strategy.

The configured `entry` option selects the file bundled by a given Vite
configuration:

```ts
daroyan({
  entry: "app/server.node.ts",
  build: {
    fileName: "server.mjs",
  },
});
```

The server adapter is a user dependency and may remain external or be
bundled according to the implementation's single-entry rules.

## 20. Development behavior

`vp dev` loads the configured user server entry through Daroyan's Vite
development environment. The entry remains responsible for initialization,
listener creation, and cleanup.

Development requirements:

- Daroyan transforms and serves the same assembled app used for build.
- Editing route code updates request handling without regenerating the
  route manifest.
- Adding, deleting, or renaming a route rescans the manifest, regenerates
  RPC and optional companion types, and restarts or reloads the user entry
  as required.
- Daroyan must not install its own signal handlers into the application.
- When Daroyan must restart an isolated development server process, it
  terminates it through normal process semantics so the user's handlers can
  run.
- Route conflicts and syntax failures retain a clear last-known-good/error
  boundary rather than silently serving a different graph.

The exact worker/process isolation mechanism is an implementation detail,
but it must preserve user ownership of the server lifecycle.

## 21. Production build

`vp build`:

1. scans and validates routes;
2. refreshes generated type artifacts;
3. creates the assembled application module;
4. bundles the configured user server entry;
5. emits one JavaScript entry by default.

Default output:

```text
dist/
└── server.mjs
```

Daroyan does not add listener startup code to the output. Running the file
executes exactly the user's server entry:

```sh
node dist/server.mjs
```

or, for a Bun entry:

```sh
bun dist/server.mjs
```

The one-entry guarantee covers ordinary JavaScript and TypeScript
dependencies. It does not imply embedding:

- native `.node` addons;
- files opened through `node:fs`;
- migration directories;
- templates and other runtime assets;
- external WASM files.

Unexpected extra JavaScript chunks are a build error unless a future
explicit multi-chunk option is added.

## 22. Deterministic route assembly

One normalized manifest drives:

- development registration;
- production registration;
- route and middleware companion types;
- the RPC type;
- conflict diagnostics.

Registration priority:

1. static segments;
2. dynamic segments;
3. catch-all segments;
4. normalized URL as a lexical tiebreaker;
5. methods in the fixed order `GET`, `POST`, `PUT`, `PATCH`, `DELETE`,
   `OPTIONS`.

The generated `.daroyan/manifest.json` exists for debugging. Production
code does not read it from disk.

Example:

```json
{
  "version": 1,
  "basePath": "/",
  "routes": [
    {
      "kind": "methods",
      "file": "app/routes/api/users/index.ts",
      "path": "/api/users",
      "methods": ["GET", "POST"],
      "middleware": ["app/routes/api/_middleware.ts"]
    },
    {
      "kind": "methods",
      "file": "app/routes/api/users/$id.ts",
      "path": "/api/users/:id",
      "methods": ["GET"],
      "middleware": ["app/routes/api/_middleware.ts"]
    },
    {
      "kind": "sub-router",
      "file": "app/routes/admin.ts",
      "mountPath": "/admin",
      "middleware": []
    }
  ]
}
```

Every route record has an explicit `kind`:

- `methods` records contain a normalized path and detected uppercase
  method exports;
- `sub-router` records contain a mount path and a default Hono export.

Both record kinds contain the ordered root-to-leaf directory middleware
files that apply to them. A sub-router record reserves its entire mount
namespace.

Generated artifacts use project-relative normalized paths, never absolute
machine paths.

## 23. RPC design

Daroyan RPC is Hono RPC. Daroyan does not define another wire protocol.

The generator creates a chained Hono application in `.daroyan/rpc.ts`:

```ts
import { Hono } from "hono";
import type { ProjectEnv } from "daroyan/app";

import admin from "../app/routes/admin";
import apiMiddleware from "../app/routes/api/_middleware";
import { GET as usersGet, POST as usersPost } from "../app/routes/api/users";
import { GET as userGet } from "../app/routes/api/users/$id";

const routes = new Hono<ProjectEnv>()
  .get("/api/users", ...apiMiddleware, ...usersGet)
  .post("/api/users", ...apiMiddleware, ...usersPost)
  .get("/api/users/:id", ...apiMiddleware, ...userGet)
  .route("/admin", admin);

export type AppType = typeof routes;
```

Named method registrations contain the same ordered directory and
route-local handler chain used by the runtime assembler. This allows Hono
to merge validator inputs, middleware early responses, and handler
responses into the generated schema.

Default sub-routers are imported as default values and mounted through a
chained `.route(mountPath, router)` call. Their internal chained schema
therefore reaches `AppType` and the generated client.

The real generator also incorporates any chain-typed manual routes from
the base app when feasible.

Invariants:

- runtime assembly and RPC generation consume the same normalized
  route-kind, path, method, and middleware metadata;
- named method routes use the same ordered root-to-leaf directory,
  route-local, and final-handler chain in both representations;
- every default sub-router is mounted through `.route()` in both
  representations;
- method detection uses parsed exports, not source substring searches;
- every generated Hono registration is chained and assigned;
- optional `Route` imports do not affect RPC generation;
- validators, typed middleware responses, and handler responses remain the
  source of request and response types;
- generated imports are portable and project-relative.

This shared metadata guarantee does not claim that middleware manually
registered on the base app, or surrounding directory middleware responses
for opaque default sub-router internals, become part of every RPC response
union.

### 23.1 Generated client

`.daroyan/client.ts` precomputes the client type:

```ts
import type { AppType } from "./rpc";
import { hc } from "hono/client";

const typedClient = hc<AppType>("");

export type Client = typeof typedClient;
export type { AppType };

export const createClient = (...args: Parameters<typeof hc>): Client => hc<AppType>(...args);

export type { InferRequestType, InferResponseType } from "hono/client";
```

The implementation may avoid constructing a placeholder client at runtime,
but the emitted declarations should precompute `Client` to reduce repeated
editor type instantiation.

### 23.2 Package export

An API workspace can expose its generated client:

```jsonc
{
  "name": "@acme/api",
  "type": "module",
  "exports": {
    "./client": "./.daroyan/client.ts",
    "./rpc": "./.daroyan/rpc.ts",
  },
}
```

The consumer:

```ts
import { createClient } from "@acme/api/client";

export const api = createClient("http://localhost:3000", {
  init: {
    credentials: "include",
  },
});
```

Type-only server imports must not cause route implementations, database
clients, secrets, or Node/Bun adapters to enter a browser bundle.

### 23.3 Client usage

```ts
const response = await api.api.users.$post({
  json: {
    name: "Ada",
    email: "ada@example.com",
  },
});

if (response.status === 201) {
  const { user } = await response.json();
}
```

Dynamic parameter:

```ts
const response = await api.api.users[":id"].$get({
  param: {
    id: "usr_123",
  },
});

if (response.status === 404) {
  const error = await response.json();
}

if (response.ok) {
  const { user } = await response.json();
}
```

Validated query:

```ts
// Route
const query = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const GET = defineHandler(zValidator("query", query), async (c) => {
  const input = c.req.valid("query");
  return c.json(await listUsers(input), 200);
});
```

```ts
// Client
await api.api.users.$get({
  query: {
    cursor: "next-token",
    limit: "50",
  },
});
```

### 23.4 RPC guarantees and boundaries

Daroyan guarantees:

- discovered paths and exported methods appear on `Client`;
- paths declared by a chained default sub-router appear beneath its mount
  path on `Client`;
- validator-declared request inputs flow to the client;
- filename parameters flow to the client's `param` input;
- typed early responses from flattened directory middleware flow to named
  method routes;
- `c.json()` bodies and explicit statuses flow to the client;
- adding, removing, or renaming a route updates the contract.

Daroyan does not claim:

- runtime validation without a validator;
- filename-derived server parameter-key checking without optional `Route`;
- inference for an untyped `await c.req.json()`;
- automatic inference of responses hidden behind base-app middleware;
- automatic addition of surrounding directory-middleware responses to
  every internal route of an opaque default sub-router;
- version compatibility between independently deployed client and server.

Handlers should return typed JSON responses with explicit status codes. A
route should return a typed JSON `404` instead of `c.notFound()` when that
response must appear in the RPC contract.

## 24. Testing

Vite-powered tests import the same assembled app as the server:

```ts
import { testClient } from "hono/testing";
import { expect, test } from "vite-plus/test";
import app from "daroyan/entry";

const client = testClient(app);

test("GET /health", async () => {
  const response = await client.health.$get();

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true });
});
```

Low-level testing remains available:

```ts
const response = await app.request("/api/users/usr_123");
```

Importing the assembled app does not execute `app/server.ts`, create a
listener, initialize production resources, or register signals.

Integration tests that exercise startup or graceful shutdown import or
spawn the user's server entry explicitly.

## 25. Generated artifacts

```text
.daroyan/
├── client.ts
├── daroyan.d.ts
├── manifest.json
├── rpc.ts
└── types/
    ├── app.d.ts
    ├── entry.d.ts
    └── app/routes/
        ├── +types/
        │   ├── _middleware.d.ts
        │   └── index.d.ts
        └── api/users/
            └── +types/
                ├── $id.d.ts
                └── index.d.ts
```

Requirements:

- every generated file begins with a “do not edit” notice;
- `.daroyan/daroyan.d.ts` contains the project marker augmentation needed
  to bind `daroyan/app` helpers to the configured app environment;
- writes are atomic;
- unchanged files keep their modification time;
- removed and renamed routes delete stale companions;
- generation failure cannot leave a partially updated RPC contract;
- generated files contain a format version;
- companion generation happens regardless of whether routes import them.

Generation runs automatically when Vite loads the plugin for development,
tests, preview, or build.

The package also exposes:

```sh
daroyan typegen
```

This loads `vite.config.ts`, finds `daroyan()`, performs the same scan and
generation, then exits without executing the user's server entry. It exists
for clean standalone type checking:

```jsonc
{
  "scripts": {
    "typecheck": "daroyan typegen && tsc --noEmit",
  },
}
```

## 26. Diagnostics

Build errors:

- missing or invalid default app export;
- configured app export is not created by `defineApp()`;
- missing routes directory;
- missing server entry during dev or build;
- duplicate normalized paths;
- equivalent dynamic route shapes;
- a default sub-router whose mount namespace overlaps a descendant file
  route;
- non-final catch-all segments;
- invalid dynamic parameter names;
- mixed default sub-router and method exports;
- unsupported method export values;
- default export that is not a Hono sub-router;
- unresolved `daroyan/entry`, which means the Vite plugin did not run;
- production output unexpectedly split into multiple JavaScript chunks.

Warnings:

- a route file exports no supported methods;
- TypeScript is not strict;
- generated client package export is missing;
- a parameter schema does not correspond to the filename parameters when
  Daroyan can prove the mismatch;
- base-app middleware returns responses absent from file-route RPC
  contracts;
- directory middleware surrounding a default sub-router returns responses
  absent from the sub-router's internal RPC contracts;
- external runtime assets weaken the one-entry deployment model.

Omitting `Route` or `Middleware` companion types is never a warning. It is
a supported API choice.

Example conflict:

```text
[daroyan] Route conflict for /api/users
  - app/routes/api/users.ts
  - app/routes/api/users/index.ts

Remove one file or choose a different URL.
```

Example sub-router namespace conflict:

```text
[daroyan] Route namespace conflict at /admin
  - app/routes/admin.ts default-exports a Hono sub-router
  - app/routes/admin/stats.ts maps beneath the same mount

A default sub-router owns its complete mount namespace.
Move the nested route into the sub-router or use named method files.
```

## 27. Public package exports

```jsonc
{
  "bin": {
    "daroyan": "./dist/cli.mjs",
  },
  "exports": {
    ".": {
      "types": "./dist/index.d.mts",
      "import": "./dist/index.mjs",
    },
    "./app": {
      "types": "./dist/app.d.mts",
      "import": "./dist/app.mjs",
    },
    "./entry": {
      "types": "./dist/entry.d.mts",
      "import": "./dist/entry.mjs",
    },
    "./package.json": "./package.json",
  },
  "peerDependencies": {
    "hono": "^4.0.0",
    "vite-plus": "^0.2.0",
  },
}
```

`@hono/node-server` is not a Daroyan dependency. Node applications install
it themselves, while Bun applications use their selected Bun API.

Route modules import runtime-safe helpers from `daroyan/app`. Vite plugin
implementation and Node built-ins must not enter route or browser graphs.

`daroyan/entry` is a Vite-resolved project module. Its packaged JavaScript
target is only an explanatory fallback for imports made without the
Daroyan plugin; it is never the application used by a valid build.

Exact peer version ranges must be chosen from compatibility testing before
publication.

## 28. Complete example

### 28.1 Vite

```ts
// vite.config.ts
import { daroyan } from "daroyan";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [daroyan()],
});
```

### 28.2 App

```ts
// app/app.ts
import { logger } from "hono/logger";
import { defineApp } from "daroyan/app";

import type { User } from "./types";

export type AppEnv = {
  Variables: {
    requestId: string;
    user: User;
  };
};

const app = defineApp<AppEnv>();

app.use("*", logger());

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: "INTERNAL_ERROR" as const }, 500);
});

app.notFound((c) => {
  return c.json({ error: "NOT_FOUND" as const }, 404);
});

export default app;
```

### 28.3 Root middleware

```ts
// app/routes/_middleware.ts
import { defineMiddleware } from "daroyan/app";

import { authenticate } from "../lib/auth";

export default defineMiddleware(
  async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    await next();
  },
  async (c, next) => {
    const user = await authenticate(c.req.raw);

    if (!user) {
      return c.json({ error: "UNAUTHORIZED" as const }, 401);
    }

    c.set("user", user);

    await next();
  },
);
```

### 28.4 Collection route

```ts
// app/routes/api/users/index.ts
import { zValidator } from "@hono/zod-validator";
import { defineHandler } from "daroyan/app";
import { z } from "zod";

const createUser = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});

export const GET = defineHandler(async (c) => {
  const users = await listUsers();
  return c.json({ users }, 200);
});

export const POST = defineHandler(zValidator("json", createUser), async (c) => {
  const user = await insertUser(c.req.valid("json"));
  return c.json({ user }, 201);
});
```

### 28.5 Resource route using parameter validation

```ts
// app/routes/api/users/$id.ts
import { zValidator } from "@hono/zod-validator";
import { defineHandler } from "daroyan/app";
import { z } from "zod";

const params = z.object({
  id: z.string().min(1),
});

export const GET = defineHandler(zValidator("param", params), async (c) => {
  const { id } = c.req.valid("param");
  const user = await findUser(id);

  if (!user) {
    return c.json({ error: "NOT_FOUND" as const }, 404);
  }

  return c.json({ user }, 200);
});
```

### 28.6 Resource route using optional `Route`

The same route could additionally opt into filename-derived typing:

```ts
import type { Route } from "./+types/$id";

export const GET = defineHandler<Route>(zValidator("param", params), async (c) => {
  const { id } = c.req.valid("param");
  return c.json({ user: await findUser(id) }, 200);
});
```

### 28.7 Node server

```ts
// app/server.ts
import { serve } from "@hono/node-server";

import app from "daroyan/entry";
import { shutdown } from "./shutdown";
import { initDatabase } from "./lib/db";
import { initRedis } from "./lib/redis";

await Promise.all([initDatabase(), initRedis()]);

const server = serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 3000),
});

process.once("SIGINT", () => {
  void shutdown(server, "SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown(server, "SIGTERM");
});
```

### 28.8 Client

```ts
import { createClient } from "@acme/api/client";

const api = createClient("http://localhost:3000");

const response = await api.api.users[":id"].$get({
  param: {
    id: "usr_123",
  },
});

if (response.status === 200) {
  const { user } = await response.json();
}

if (response.status === 401) {
  const { error } = await response.json();
  // error: "UNAUTHORIZED"
}
```

## 29. Implementation architecture

This section constrains the future implementation without implementing it.

### 29.1 Scanner

- Resolve paths relative to Vite's resolved project root.
- Parse route modules with an AST parser.
- Normalize separators to `/`.
- Classify every route as a named-method record or default sub-router
  record.
- Reserve a default sub-router's complete mount namespace.
- Validate conflicts before runtime or RPC generation.
- Produce one serializable normalized manifest.

### 29.2 Runtime assembler

- Import the configured default Hono app.
- Import all directory middleware and route modules.
- Register global app middleware first because it already exists on the
  instance.
- For every named method route, flatten its root-to-leaf directory
  middleware and exported handler tuple into one runtime registration.
- Mount every default sub-router through `.route()` and ensure its
  root-to-leaf directory middleware still runs once at runtime.
- Register all routes deterministically.
- Export the same assembled instance through `daroyan/entry`.
- Never start or stop a listener.

### 29.3 Type generator

- Infer the Hono environment from the configured app export.
- Generate `.daroyan/daroyan.d.ts`, merging the configured app type into
  `DaroyanProject`.
- Derive `ProjectEnv` from that marker and bind project-level
  `defineHandler` and `defineMiddleware` types without route-level
  `AppEnv` generics.
- Generate optional route and middleware companions.
- Generate named RPC registrations with the same flattened middleware and
  handler tuples used at runtime.
- Generate chained `.route()` registrations for default sub-routers.
- Generate a precomputed client module.
- Use atomic content-aware writes.

### 29.4 Vite integration

- `config`: establish the user server entry and single-entry build defaults.
- `configResolved`: scan, validate, and generate.
- development hooks: execute the configured user entry in an isolated,
  reloadable environment without taking over its lifecycle.
- `resolveId` and `load`: resolve `daroyan/entry` internally as
  `\0daroyan/entry`.
- build hooks: assert the expected entry filename and no unexpected chunks.
- test integration: expose the assembled app without executing the server
  entry.

The implementation should use Vite's current environment/module-runner
APIs rather than deprecated SSR-loading behavior.

## 30. Acceptance criteria

v0.1 is complete when:

- `plugins: [daroyan()]` is the only required Vite integration.
- `defineApp()` returns a normal Hono instance.
- the app module uses ordinary Hono APIs and default-exports the instance.
- `daroyan/entry` exposes the assembled app without a user-facing
  `virtual:` import.
- Daroyan exposes no application lifecycle or shutdown API.
- the user's Node or Bun entry controls the native server handle and
  signals.
- route files work without generated imports.
- an environment declared once through `defineApp<AppEnv>()` types
  `c.var` in every `defineHandler()` and `defineMiddleware()` call without
  repeating `AppEnv`;
- optional `defineHandler<Route>()` provides exact filename parameters.
- `zValidator("param", ...)` provides typed, runtime-validated parameters
  without requiring `Route`.
- static, dynamic, nested, index, and catch-all routes work.
- ancestor middleware stacks root-to-leaf, applies to a route at the
  middleware directory's exact URL, and runs once.
- one `_middleware.ts` can declare multiple ordered middleware handlers.
- validators, typed directory-middleware early responses, and typed JSON
  handler responses reach the generated client for named method routes.
- a default-exported chained Hono sub-router is mounted through `.route()`
  and its internal paths reach the generated client.
- a default sub-router cannot overlap descendant file routes beneath its
  mount namespace.
- route changes update runtime registration, companion types, and RPC.
- runtime and RPC generation consume the same normalized route-kind, path,
  method, and middleware metadata.
- Node and Bun example entries build and run independently.
- conflicts and invalid modules fail with actionable diagnostics.
- `daroyan typegen` prepares a clean checkout for type checking.
- `vp check` and `vp test` pass for the package and example applications.

## 31. Remaining decisions before implementation

1. **App defaults.** Decide whether `defineApp()` should use Hono's default
   strict routing or set `strict: false`. The user can always override it
   through `defineApp(options)`.
2. **Development isolation.** Choose the Vite environment or child-process
   mechanism that can reload the user-owned server entry without stealing
   lifecycle ownership.
3. **Manual route RPC.** Decide how much chain-typed schema from the base app
   should be merged into generated file-route RPC.
4. **Bun build testing.** Establish supported Bun versions and test native
   shutdown behavior without abstracting it.
5. **Single-entry dependencies.** Define the exact rule for externalized
   dependencies and runtime assets.

These implementation decisions must not change the confirmed authoring
surface:

```ts
const app = defineApp();

// Use normal Hono APIs.

export default app;
```
