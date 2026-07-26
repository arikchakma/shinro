# Shinro

Opinionated file-based routing for Hono with end-to-end type safety.

Shinro discovers route modules through one Vite plugin, exposes them as a Hono
sub-router, and generates a typed Hono client. You decide where to mount the
routes, how to start the server, and how to handle signals and graceful
shutdown.

Its scope is deliberately narrow: a documented set of filename conventions,
one routing integration, and no abstraction over your server lifecycle. For
anything outside that scope, use Hono directly.

## Install

```sh
vp add hono
vp add -D shinro
```

For Node.js:

```sh
vp add @hono/node-server
```

Bun can use `Bun.serve()` directly.

## Configure

```ts
// vite.config.ts
import { shinro } from 'shinro';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [shinro()],
});
```

Shinro is the only routing integration. There is no Node plugin, Bun
plugin, RPC plugin, or lifecycle plugin.

Extend the bundled base config. It configures `moduleResolution`, TypeScript
import extensions, `rootDirs`, and the `include` patterns for generated
declarations. As a result, `shinro/app` and `shinro/routes` resolve without
hand-written `paths`:

```jsonc
// tsconfig.json
{
  "extends": "shinro/tsconfig",
  "compilerOptions": {
    "paths": {
      "~/*": ["./src/*"],
    },
  },
}
```

`shinro/routes`, `shinro/client`, and `shinro/rpc` resolve through a
generated `.shinro/shinro.d.ts` (ambient module declarations), and
`shinro/app` resolves through the package `exports` — none needs a `paths`
entry.

The base config includes both `.shinro/**/*.d.ts` and `.shinro/**/*.ts`. This
loads the ambient declarations and type-checks the generated router with the
rest of the project, even when nothing imports it. Both patterns are required
because TypeScript's `*.ts` glob does not match `.d.ts` files.

The shipped base hardcodes the default `.shinro` location. A project that
sets `rpc.outDir` elsewhere cannot extend it and should merge the equivalent
`rootDirs` and `include` entries by hand; Shinro's warning prints them for
the directory you configured.

Ignore generated and build output:

```gitignore
.shinro/
dist/
```

## Create the app

```ts
// app/app.ts
import { logger } from 'hono/logger';
import { defineApp } from 'shinro/app';
import { routes } from 'shinro/routes';

declare module 'shinro/app' {
  interface ShinroEnv {
    Variables: {
      requestId: string;
    };
  }
}

const app = defineApp()
  .use('*', logger())
  .route('/', routes())
  .onError((error, c) => {
    console.error(error);
    return c.json({ error: 'INTERNAL_ERROR' as const }, 500);
  });

export default app;
```

`shinro/routes` exposes your file routes as a Hono sub-router. You mount it
yourself. `route()` copies the sub-router's routes and schema onto your app and
returns the same instance. The result is one Hono instance, no nested dispatch,
and a complete RPC contract in `typeof app`, including manual routes.

Shinro warns about two common mounting mistakes:

- **Mount after your global middleware.** Hono composes handlers in registration
  order, so middleware registered after the mount never wraps a file route.
- **Mount the router.** An app that never calls `routes()` is valid Hono, but
  serves none of your route files.

`defineApp()` only calls `new Hono()`, so reaching for Hono directly works
equally well:

```ts
import { Hono } from 'hono';

export default new Hono<ProjectEnv>().route('/', routes());
```

`defineApp()` defaults to the project environment, allowing `defineApp()` and
`defineHandler()` to share that environment without repeated generics. A
`new Hono()` app is otherwise identical.

You can type context variables two ways, and they compose:

- **Project-wide**, as above — augment `ShinroEnv` once, and every
  `defineHandler()` and `defineMiddleware()` call uses it. Shinro does not read
  your app's source to determine this type, allowing `app.ts` to import the
  generated router without creating a type cycle.
- **Per file**, using Hono's native approach — the module that sets a variable
  declares it, so no central env is required:

  ```ts
  declare module 'hono' {
    interface ContextVariableMap {
      requestId: string;
    }
  }
  ```

Use `Bindings` on `ShinroEnv` when a handler needs typed `c.env` — on Node,
`@hono/node-server` passes `{ incoming, outgoing }` there on every request:

```ts
declare module 'shinro/app' {
  interface ShinroEnv {
    Bindings: HttpBindings;
  }
}
```

`ShinroEnv` is program-wide, so one TypeScript project has one project
environment. That matches the v0.1 scope of one Shinro application per
TypeScript project.

Server startup and shutdown stay in your application code.

## Add routes

```ts
// app/routes/health.ts
import { defineHandler } from 'shinro/app';

export const GET = defineHandler((c) => {
  return c.json({ ok: true as const }, 200);
});
```

One file can handle multiple methods:

```ts
// app/routes/api/users.ts
import { zValidator } from '@hono/zod-validator';
import { defineHandler } from 'shinro/app';
import { z } from 'zod';

const input = z.object({
  name: z.string().min(1),
});

export const GET = defineHandler(async (c) => {
  return c.json({ users: [] }, 200);
});

export const POST = defineHandler(zValidator('json', input), async (c) => {
  const user = c.req.valid('json');
  return c.json({ user }, 201);
});
```

Supported named exports are `GET`, `POST`, `PUT`, `PATCH`, `DELETE`,
`OPTIONS`, and `ALL`. A matching `GET` also handles `HEAD` through Hono.

`ALL` registers after the explicit methods, so a file exporting both `GET` and
`ALL` serves GET requests from `GET` and every other verb from `ALL`.

### File-to-URL mapping

| File                            | URL                |
| ------------------------------- | ------------------ |
| `app/routes/index.ts`           | `/`                |
| `app/routes/health.ts`          | `/health`          |
| `app/routes/api/users.ts`       | `/api/users`       |
| `app/routes/api/users/index.ts` | `/api/users`       |
| `app/routes/api/users/$id.ts`   | `/api/users/:id`   |
| `app/routes/files/$...path.ts`  | `/files/:path{.+}` |
| `app/routes/(authed)/orders.ts` | `/orders`          |
| `app/routes/[(foo)].ts`         | `/(foo)`           |

Catch-all parameters match one or more segments. Static routes register
before dynamic routes, which register before catch-alls.

A `(name)` directory is a **route group**: it scopes directory middleware
without contributing a URL segment. `[...]` escapes any of these
conventions. Both are covered below, and every convention is collected in
[File route conventions](../../docs/file-route-conventions.md).

Files beginning with `_` or `.`, declaration files, test/spec files, and
files under `__tests__`, `__fixtures__`, `.dot-directories`, or `+types`
are not routes. A route group is pathless, not ignored — its routes and its
`_middleware.ts` are live.

Additional files can be excluded with route-relative globs, matched by
[`path.matchesGlob`](https://nodejs.org/api/path.html#pathmatchesglobpath-pattern).
A match excludes both route modules and directory middleware:

```ts
shinro({
  ignoredRouteFiles: ['internal/**', '**/*.draft.ts'],
});
```

A method export is spread into Hono, so it must be an array of handlers.
`defineHandler()` is the convenient spelling, but a shared tuple or a project
wrapper works too:

```ts
export const GET = sharedHandlers;
export const POST = withAudit(...defineHandler(handler));
```

Shinro rejects only what is provably wrong at scan time — an empty tuple, a
tuple holding a non-handler, a bare function, and method-named function/class
declarations or external re-exports, none of which can be spread. Anything
else is left to TypeScript, which checks it against your own source.

## Directory middleware

`_middleware.ts` applies to the route at its directory URL and every
descendant. It can export multiple middleware handlers:

```ts
// app/routes/api/_middleware.ts
import { defineMiddleware } from 'shinro/app';
import type { Route } from './+types/_middleware.ts';

export default defineMiddleware<Route.Middleware>(
  async (c, next) => {
    c.header('x-api-version', '1');
    await next();
  },
  async (c, next) => {
    c.set('requestId', crypto.randomUUID());
    await next();
  }
);
```

For `/api/users`, middleware stacks from the route root toward the leaf:

```text
app/routes/_middleware.ts
app/routes/api/_middleware.ts
app/routes/api/users.ts
```

Shinro flattens this chain onto named routes. Typed early responses from
directory middleware, such as a `401`, therefore enter that route's RPC
response union.

### Behavior for unmatched requests

Because the chain is attached to each named route rather than to a path
prefix, directory middleware runs **only when a route matches**. A request to
`/api/does-not-exist` goes straight to the not-found handler without running
`app/routes/api/_middleware.ts`, and so does an `OPTIONS` preflight to a path
that has no route.

This behavior keeps the RPC contract accurate: every response a client can
receive is represented in the type. Cross-cutting concerns that must cover
_every_ request — CORS, request IDs, access logging, and tracing — therefore
belong on the base app, where Hono middleware applies to all requests:

```ts
// app/app.ts
app.use('*', cors());
app.use('*', requestId());
```

Keep `_middleware.ts` for route-scoped concerns such as authenticating a
section of the API, where running only on real routes is what you want.

### Group directories

Middleware inheritance follows directory containment. To scope middleware to
some sibling URLs but not others, organize those routes under a directory named
`(name)`. The directory contributes middleware ancestry but no URL segment:

```text
app/routes/(authed)/_middleware.ts   ← auth
app/routes/(authed)/orders.ts        → /orders    (authed)
app/routes/(authed)/billing.ts       → /billing   (authed)
app/routes/health.ts                 → /health    (public)
```

`/orders` is protected, `/health` is not, and neither URL mentions the group.
Routes cannot opt out: every route inside a middleware directory is wrapped,
keeping the behavior predictable.
`.shinro/manifest.json` records the group in each route's `file` and
`middleware` entries, so the wrapping is visible even though no URL shows it.

Groups nest, and `(authed)/index.ts` serves the group's parent URL. A group
name never reaches a URL, so it cannot declare a parameter — `($id)` is
rejected, as are `()` and an unbalanced `(authed`.

### Escaping conventions

To serve a character that route syntax would otherwise claim, wrap it in
`[...]`, following React Router's convention:

| File                          | URL            |
| ----------------------------- | -------------- |
| `app/routes/[sitemap.xml].ts` | `/sitemap.xml` |
| `app/routes/[(foo)].ts`       | `/(foo)`       |
| `app/routes/[$]id.ts`         | `/$id`         |
| `app/routes/[index].ts`       | `/index`       |
| `app/routes/[[weird]].ts`     | `/[weird]`     |

An escape makes its segment static, so it is never read as a parameter or a
group. A `[` matches the next `]`, and a stray `[` is an ordinary character.
Because the point of escaping is emitting a literal, two shapes are rejected
rather than silently reinterpreted: a dynamic segment containing an escape
(`$id[.pdf].ts`, which Hono would read as the parameter `id.pdf`), and a
resolved segment holding Hono path syntax (`[:]id.ts`, `{`, `}`, `*`, `?`).

Route-local middleware and validators go directly in `defineHandler()`:

```ts
export const POST = defineHandler(
  requireUser,
  zValidator('json', input),
  async (c) => {
    return c.json({ user: c.req.valid('json') }, 201);
  }
);
```

## Parameters and optional companions

Routes do not need generated imports. For runtime-validated input, prefer a
Hono validator:

```ts
// app/routes/users/$id.ts
const params = z.object({ id: z.string().min(1) });

export const GET = defineHandler(zValidator('param', params), (c) => {
  const { id } = c.req.valid('param');
  return c.json({ id }, 200);
});
```

Shinro also generates an optional filename companion:

```ts
import { defineHandler } from 'shinro/app';
import type { Route } from './+types/$id.ts';

export const GET = defineHandler<Route.Handler>((c) => {
  const id = c.req.param('id');
  return c.json({ id }, 200);
});
```

The companion supplies the filename-derived path and parameter names. It does
not validate requests at runtime; use a validator when validation is required.
Middleware and validators can still precede the handler, but an explicit type
argument stops TypeScript inferring what follows it, so under the companion a
validator runs without typing `c.req.valid()`. Read validated input from the
inferred form instead.
Shinro cross-checks `"param"` schemas against filename parameters for any Hono
validator. The validators from `hono/validator` and `@hono/*-validator`
packages (`zValidator`, `vValidator`, `sValidator`, and others) share the same
`factory("param", schema)` shape.

Supplying the explicit `Route.Handler` generic can widen response and status
inference because TypeScript does not partially infer later generic parameters
after an explicit one.

## Chained sub-routers and manual routes

A route file can default-export a chained Hono sub-router:

```ts
// app/routes/admin.ts
import { Hono } from 'hono';

export default new Hono()
  .get('/', (c) => c.json({ section: 'admin' }, 200))
  .get('/stats', (c) => c.json({ activeUsers: 42 }, 200));
```

This creates `/admin` and `/admin/stats`, including both in the generated
client. The file owns the complete `/admin` namespace, so it cannot coexist
with `app/routes/admin/**` or a dynamic file route that can match beneath
that namespace.

`basePath` prefixes **file routes only**. Routes you register on the app
yourself are left exactly as written, so a manual route that should sit under
the prefix has to spell it out:

```ts
shinro({ basePath: '/v1' });

const app = defineApp().get('/v1/manual', handler);
```

Manual routes are also valid:

```ts
const app = defineApp().get('/manual', (c) => {
  return c.json({ manual: true as const }, 200);
});
```

Keeping the Hono chain intact, as above, includes `/manual` in RPC. An
unassigned call such as `app.get('/manual', handler)` still registers the
route, but Hono does not retain its schema in `typeof app`, so the route cannot
appear in the client type.

## Generated route table

`.shinro/routes.ts` contains one chained Hono registration per route in a
single exported function. The `shinro/routes` specifier resolves to this file,
which imports only your route modules:

```ts
// .shinro/routes.ts
export function routes() {
  return new Hono<ProjectEnv>()
    .get('/health', ...route0GET)
    .post('/api/users', ...route1Middleware0, ...route1POST);
}
```

Because the generated router never imports your app, your app can safely import
it. The chain gives Hono the schema required for RPC, and `route()` merges that
schema into your app at the mount. Consequently, `typeof app` describes the
complete contract. No generated module replaces your application:
`app/app.ts` remains the routed app.

Error handling stays on your app. The generated router deliberately has no
`onError`, because Hono's `route()` wraps every copied handler in a compose
closure when the sub-app carries its own error handler.

## RPC client

Shinro generates `.shinro/client.ts`, and `.shinro/rpc.ts` re-exports
`AppType` from it for workspaces that publish their types:

```ts
import { defineClient } from './.shinro/client.ts';

const api = defineClient('http://localhost:3000');

const response = await api.api.users.$post({
  json: {
    name: 'Ada',
  },
});

if (response.status === 201) {
  const body = await response.json();
}
```

Dynamic parameters use Hono RPC syntax:

```ts
await api.users[':id'].$get({
  param: {
    id: 'usr_123',
  },
});
```

An API workspace can publish its generated types:

```jsonc
{
  "exports": {
    "./client": "./.shinro/client.ts",
    "./rpc": "./.shinro/rpc.ts",
  },
}
```

Set `rpc.enabled` to `false` when the project does not need a generated client.
Routing is unaffected: `.shinro/routes.ts` and its declaration are always
generated, since mounting them is how the application serves anything.

## Own the server lifecycle

Node example:

```ts
// app/server.ts
import { serve } from '@hono/node-server';

import app from './app.ts';

const server = serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 3000),
});

process.once('SIGTERM', () => {
  server.close();
});
```

Bun example:

```ts
// app/server.ts
import app from './app.ts';

const server = Bun.serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 3000),
});

process.once('SIGTERM', () => {
  void server.stop(false);
});
```

These are application decisions. Shinro imports the configured entry
during development and bundles that exact entry for production; it never
creates or hides the native server.

## Development, type generation, and build

```sh
vp dev
shinro typegen
vp build
```

`shinro typegen` refreshes `.shinro` without starting the application
listener, which makes clean-checkout `tsc --noEmit` workflows possible.

By default the build is **unbundled** (`build.unbundle: true`): the output
preserves your source module tree and keeps dependencies external, so `dist`
mirrors `src` and remains easy to inspect. `dist/server.mjs` is always the entry
that boots the app:

```text
dist/
├── server.mjs
├── app.mjs
├── .shinro/
│   └── routes.mjs
└── routes/
    └── health.mjs
```

`node dist/server.mjs` boots this output, resolving dependencies from
`node_modules` at runtime. Set `build.unbundle: false` for a self-contained
single-artifact build: ordinary JavaScript dependencies are bundled into one
`dist/server.mjs`, extra JavaScript chunks become an error, and emitted
runtime assets produce a warning. Node built-ins remain native in both modes;
native addons, migrations, templates, files opened at runtime, and external
WASM remain application deployment concerns.

## Options

```ts
shinro({
  app: 'app/app.ts',
  entry: 'app/server.ts',
  routes: 'app/routes',
  basePath: '/',
  build: {
    outDir: 'dist',
    fileName: 'server.mjs',
    minify: false,
    sourcemap: false,
    unbundle: true,
  },
  rpc: {
    enabled: true,
    outDir: '.shinro',
  },
});
```

Server settings such as the port, hostname, signals, and shutdown behavior
belong in your application rather than the Shinro plugin.

v0.1 supports one `shinro()` plugin instance per TypeScript project.
Separate applications in a monorepo use separate Vite configurations and
TypeScript programs.

See the repository [specification](../../docs/SPEC.md) for the complete v0.1
contract, diagnostics, and test requirements.

## License

[MIT](./LICENSE) &copy; [Arik Chakma](https://x.com/imarikchakma)
