# Shinro

Opinionated file-based routing for Hono with end-to-end type safety.

Shinro turns a directory of route modules into a real file on disk, exposes it as
a Hono sub-router, and generates a typed Hono client. You decide where to mount
the routes, which runner starts the server, and how to handle signals and
graceful shutdown.

Its scope is deliberately narrow: a documented set of filename conventions, one
generator, and no abstraction over your server lifecycle or your build. For
anything outside that scope, use Hono directly.

## Install

```sh
vp add hono shinro
```

`shinro/app` is imported by your route files, so `shinro` is a dependency rather
than a dev dependency. For Node.js:

```sh
vp add @hono/node-server
```

Bun can use `Bun.serve()` directly.

## Configure

```sh
shinro init
```

`init` is idempotent, prints what it changed, and merges into what is already
there. It writes three things, and there is nothing else to configure:

```jsonc
// package.json
{
  "imports": {
    "#shinro/routes": "./.shinro/routes.ts",
    "#shinro/client": "./.shinro/client.ts",
  },
  "scripts": {
    "dev": "node --watch --watch-preserve-output --import shinro/watch src/server.ts",
    "prepare": "shinro generate",
    "check": "shinro generate --check && tsc --noEmit",
  },
}
```

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

The `imports` block is the load-bearing part, and it is deliberately not a
plugin: subpath imports are part of ESM resolution, so `#shinro/routes` resolves
in `node`, `tsx`, `bun`, `rolldown`, and TypeScript by construction rather than
because a bundler was configured. A relative import works too and is never
warned about — `import { routes } from '../.shinro/routes.ts'` needs no
`package.json` at all. `#shinro/routes` is the documented default only because it
survives moving `app.ts`.

The shipped base config carries `moduleResolution`, TypeScript import
extensions, `rootDirs`, and the `include` patterns the generated `+types`
declarations need. It uses `${configDir}`, so a base config living in
`node_modules` still expresses paths relative to _your_ project. `.shinro` is
where Shinro generates, always — that is what makes the shipped config possible.

It also carries `"lib": ["es2023", "dom", "dom.iterable"]`, which is about
`Response` rather than the browser. Hono builds every RPC response type on the
global `Response`, so a config without it types `c.json()` as `any`, drops every
route out of the schema, and leaves you with a client that has no routes and no
error explaining why. Override `lib` freely when your runtime's types supply
those globals — `@types/node`, `@cloudflare/workers-types` — because
`.shinro/routes.ts` carries a compile-time guard that fails loudly if the schema
ever does come out empty.

`shinro/tsconfig` is check-only (`noEmit`, which is what makes
`allowImportingTsExtensions` legal). A project that wants plain `tsc` to _emit_
extends `shinro/tsconfig/emit` instead, which swaps `noEmit` for
`rewriteRelativeImportExtensions` so the generated `./x.ts` specifiers become
`./x.js` in the output.

Ignore generated and build output, or commit `.shinro/` and let
`shinro generate --check` keep it honest — both are supported:

```gitignore
.shinro/
dist/
```

## Create the app

```ts
// src/app.ts
import { routes } from '#shinro/routes';
import { logger } from 'hono/logger';
import { defineApp } from 'shinro/app';

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

`#shinro/routes` exposes your file routes as a Hono sub-router. You mount it
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
// src/routes/health.ts
import { defineHandler } from 'shinro/app';

export const GET = defineHandler((c) => {
  return c.json({ ok: true as const }, 200);
});
```

One file can handle multiple methods:

```ts
// src/routes/api/users.ts
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
| `src/routes/index.ts`           | `/`                |
| `src/routes/health.ts`          | `/health`          |
| `src/routes/api/users.ts`       | `/api/users`       |
| `src/routes/api/users/index.ts` | `/api/users`       |
| `src/routes/api/users/$id.ts`   | `/api/users/:id`   |
| `src/routes/files/$...path.ts`  | `/files/:path{.+}` |
| `src/routes/(authed)/orders.ts` | `/orders`          |
| `src/routes/[(foo)].ts`         | `/(foo)`           |

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

A `-` prefix excludes a file or directory from routing, which is how a route
colocates what it is built from:

```text
src/routes/
├── posts.ts          // /posts
├── -post-schema.ts   // ignored
└── -queries/         // ignored, with everything below it
    ├── list-posts.ts
    └── insert-post.ts
```

Nothing below a `-` directory is routed, `_middleware.ts` included, so a
colocated subtree adds no middleware to the routes around it. `[-]name.ts`
serves `/-name`, for a URL segment that starts with a literal dash.

Additional files can be excluded with route-relative globs, matched by
[`path.matchesGlob`](https://nodejs.org/api/path.html#pathmatchesglobpath-pattern).
A match excludes both route modules and directory middleware:

```jsonc
// shinro.config.json
{
  "ignoredRouteFiles": ["internal/**", "**/*.draft.ts"],
}
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
// src/routes/api/_middleware.ts
import { defineMiddleware } from 'shinro/app';
import type { Route } from './+types/api/_middleware.ts';

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
src/routes/_middleware.ts
src/routes/api/_middleware.ts
src/routes/api/users.ts
```

Shinro flattens this chain onto named routes. Typed early responses from
directory middleware, such as a `401`, therefore enter that route's RPC
response union.

Any Hono middleware belongs in the tuple, not just handlers written against
the project env:

```ts
// src/routes/api/_middleware.ts
import { bearerAuth } from 'hono/bearer-auth';
import { defineMiddleware } from 'shinro/app';

export default defineMiddleware(bearerAuth({ token: process.env.API_TOKEN! }));
```

One caveat: `cors()`, `logger()`, and the rest of the middleware Hono types
against `any` will erase the env of an inline handler sharing their tuple. Give
those a `_middleware.ts` of their own, or mount them on the base app, where
they cover unmatched requests too.

### Behavior for unmatched requests

Because the chain is attached to each named route rather than to a path
prefix, directory middleware runs **only when a route matches**. A request to
`/api/does-not-exist` goes straight to the not-found handler without running
`src/routes/api/_middleware.ts`, and so does an `OPTIONS` preflight to a path
that has no route.

This behavior keeps the RPC contract accurate: every response a client can
receive is represented in the type. Cross-cutting concerns that must cover
_every_ request — CORS, request IDs, access logging, and tracing — therefore
belong on the base app, where Hono middleware applies to all requests:

```ts
// src/app.ts
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
src/routes/(authed)/_middleware.ts   ← auth
src/routes/(authed)/orders.ts        → /orders    (authed)
src/routes/(authed)/billing.ts       → /billing   (authed)
src/routes/health.ts                 → /health    (public)
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
| `src/routes/[sitemap.xml].ts` | `/sitemap.xml` |
| `src/routes/[(foo)].ts`       | `/(foo)`       |
| `src/routes/[$]id.ts`         | `/$id`         |
| `src/routes/[index].ts`       | `/index`       |
| `src/routes/[[weird]].ts`     | `/[weird]`     |

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

## Parameters and optional type declarations

Routes do not need generated imports. For runtime-validated input, prefer a
Hono validator:

```ts
// src/routes/users/$id.ts
const params = z.object({ id: z.string().min(1) });

export const GET = defineHandler(zValidator('param', params), (c) => {
  const { id } = c.req.valid('param');
  return c.json({ id }, 200);
});
```

Shinro also generates an optional filename type declaration:

```ts
import { defineHandler } from 'shinro/app';
import type { Route } from './+types/users/$id.ts';

export const GET = defineHandler<Route.Handler>((c) => {
  const id = c.req.param('id');
  return c.json({ id }, 200);
});
```

The specifier carries the route's whole path below the routes directory, so it
names one route rather than a basename like `$id.ts` that recurs across the tree.
It follows the file, not the URL: a `(group)` directory stays in the specifier
while contributing no URL segment.

The declaration supplies the filename-derived path and parameter names. It does
not validate requests at runtime; use a validator when validation is required.
Middleware and validators can still precede the handler, but an explicit type
argument stops TypeScript inferring what follows it: under the declaration a
validator rejects bad requests without typing `c.req.valid()` or contributing
its input to the generated client. Read validated input from the inferred form
instead.
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
// src/routes/admin.ts
import { Hono } from 'hono';

export default new Hono()
  .get('/', (c) => c.json({ section: 'admin' }, 200))
  .get('/stats', (c) => c.json({ activeUsers: 42 }, 200));
```

This creates `/admin` and `/admin/stats`, including both in the generated
client. The file owns the complete `/admin` namespace, so it cannot coexist
with `src/routes/admin/**` or a dynamic file route that can match beneath
that namespace.

To serve everything under a prefix, use Hono's own `basePath`. There is no
Shinro option for this, deliberately: one mechanism covers the manual routes and
the mounted file routes alike, and it stays in the schema, so the generated
client's URLs follow it for free.

```ts
const app = defineApp()
  .basePath('/v1')
  .get('/manual', handler) // served at /v1/manual
  .route('/', routes()); // file routes served under /v1 too
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

`.shinro/routes.ts` contains one chained Hono registration per route in a single
exported function. It imports your route modules by relative path with the `.ts`
extension intact, which is why every runner can execute it without help:

```ts
// .shinro/routes.ts
import { Hono } from 'hono';
import type { ProjectEnv } from 'shinro/app';

import middleware0 from '../src/routes/api/_middleware.ts';
import { GET as route0GET } from '../src/routes/health.ts';
import { POST as route1POST } from '../src/routes/api/users.ts';

export function routes() {
  return new Hono<ProjectEnv>()
    .get('/health', ...route0GET)
    .post('/api/users', ...middleware0, ...route1POST);
}
```

Nothing in it is `node:`-specific, so the same output runs on Node, Bun, Deno,
and a Worker. Generation writes into a staging directory inside `.shinro` and
promotes each file with `rename`, so a reader never sees a half-written module and
a failure leaves the previous generation byte for byte. Files whose contents are
unchanged are not rewritten at all — their modification time is untouched, which
is what keeps a watching runner from restarting in a loop.

Because the generated router never imports your app, your app can safely import
it. The chain gives Hono the schema required for RPC, and `route()` merges that
schema into your app at the mount. Consequently, `typeof app` describes the
complete contract. No generated module replaces your application:
`src/app.ts` remains the routed app.

Error handling stays on your app. The generated router deliberately has no
`onError`, because Hono's `route()` wraps every copied handler in a compose
closure when the sub-app carries its own error handler.

## RPC client

Shinro generates `.shinro/client.ts`, whose `AppType` is `typeof app` — so
manual routes and file routes are both in it without codegen assembling
anything:

```ts
import { defineClient } from '#shinro/client';

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
  },
}
```

There is no switch for this. `client.ts` is one type-only file, it costs nothing
to emit, and it is why most people are here.

On a large app, note that a consumer of `./client` re-elaborates the whole
chained server type. Hono documents that cost; past a few dozen routes, run
`tsc --declaration` over `client.ts` and publish the emitted `.d.ts` so
consumers elaborate nothing.

## Own the server lifecycle

Node example:

```ts
// src/server.ts
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
// src/server.ts
import app from './app.ts';

const server = Bun.serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 3000),
});

process.once('SIGTERM', () => {
  void server.stop(false);
});
```

These are application decisions. Shinro never imports your entry, never spawns
it, and never installs a signal handler: it guarantees only that `.shinro`
matches the route tree by the time your module graph loads.

## Development

```sh
node --watch --watch-preserve-output --import shinro/watch src/server.ts
```

That is the whole dev loop, in one process. `shinro/watch` is a side-effecting
subpath for `node --import`: it generates once — before the entry is resolved,
which is why it must be `--import` and not an import inside a dev entry — and
then keeps one debounced watcher on the routes directory.

`--watch-preserve-output` is Node's, and it earns its place: without it Node
resets the terminal on every restart, wiping the generation output, the route
conflict, and the stack trace you were reading. Drop it if you prefer a clean
screen per restart.

Plain `--watch` is graph watching, and the graph is enough because the one thing
it cannot see funnels through a file it can. A brand-new route file is invisible
to a graph watcher, since nothing imports it yet; the watcher regenerates,
`routes.ts` changes, and `routes.ts` _is_ in the graph through `#shinro/routes`,
so Node restarts. The restart re-runs the preload, which reconciles anything that
changed in the gap. One restart per real change.

Two documented alternatives, both one line:

```sh
# a directory restart instead of a resident watcher (macOS and Windows: Node
# restricts --watch-path to those platforms)
node --watch --watch-preserve-output --watch-path=src --import shinro/generate src/server.ts

# a runner with its own watcher
NODE_OPTIONS="--import shinro/generate" tsx watch --include "src/routes/**" src/server.ts
```

There is no `shinro dev`. Anything that spawned the runner would be a supervisor,
and a supervisor owes you SIGTERM semantics, log multiplexing, and exit-code
forwarding within a release.

A `.ts` entry needs Node ≥23.6 for unflagged type stripping, or 22.12 with
`--experimental-strip-types`.

## Generating, checking, and building

```sh
shinro generate           # write .shinro from the route tree
shinro generate --watch   # for a runner that can do neither half itself
shinro generate --check   # compare against disk, write nothing, exit non-zero on drift
shinro generate --tree    # print the route tree as well
shinro init               # add the imports block, tsconfig, and scripts
```

Run any of them with `--help` for the flags.

`generate` prints one line:

```
✓ wrote .shinro · 142 routes
```

That is the whole of it, because `generate` runs from `prepare` — on every
install, in every CI job — and a project with a few hundred routes would print
a few hundred lines nobody asked for. Ask for the tree when you want it:

```
$ shinro generate --tree
✓ wrote .shinro · 6 routes

  /
  ├─ api                 GET
  │  └─ users            GET
  │     └─ :id           GET PATCH
  ├─ health              GET POST
  └─ teams
     └─ :teamId
        └─ members
           └─ :memberId  GET
```

`--watch` prints one line per save and never a tree — reprinting it on every
keystroke would bury the thing you are watching for:

```
✓ watching src/routes
✓ health.ts  up to date
✓ wrote   .shinro/manifest.json, .shinro/routes.ts,
          .shinro/types/src/routes/+types/users/$id.d.ts
✓ removed .shinro/types/src/routes/+types/users/$id.d.ts
```

One line per action rather than per file, wrapped under a hanging indent. `up
to date` is the common case — editing a handler body does not change the route
tree, so nothing is written, and the triggering file is named relative to the
routes directory the line above already spelled out.

`--check` stays a gate: an exit code plus the line that explains it.

```
✗ Route conflict at "/api/users/:id"
    src/routes/api/users/$id.ts
    src/routes/api/users/$id/index.ts
```

Plain lines throughout, so it reads the same in a terminal, a pipe, and a CI
log — colour is dropped when stdout is not a TTY or `NO_COLOR` is set.

`--check` is the CI gate. Because no bundler is guaranteed to run, `generate` is
the only moment a route conflict can be caught, and `--check` is how CI fails on
one. It also fails on a stale `.shinro/`, which is what makes committing the
generated directory a supported choice rather than a trap — and it tells an
upgrade apart from a forgotten regeneration, because the artifacts carry the
format number that wrote them.

The app owns its build. With `tsdown`:

```ts
// tsdown.config.ts
import { shinro } from 'shinro/tsdown';
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/server.ts'],
  format: 'esm',
  outDir: 'dist',
  outExtensions: () => ({ js: '.mjs' }),
  platform: 'node',
  unbundle: true,
  plugins: [shinro()],
});
```

The adapter does one thing: it regenerates in `buildStart`, before rolldown
resolves the graph, so a build cannot ship stale routes. It is never
load-bearing — delete it, run `shinro generate` in the script instead, and the
output is byte-identical. `shinro/vite` is the same ~40 lines for projects
already on Vite or `vp`, and it additionally keeps the old bare `shinro/routes`
specifier resolving while a project migrates.

With `unbundle: true` the output preserves your source module tree and keeps
dependencies external, so `dist` mirrors `src` and `#shinro/routes` is resolved
at build time rather than shipped:

```text
dist/
├── server.mjs
├── app.mjs
├── .shinro/
│   └── routes.mjs
└── routes/
    └── health.mjs
```

Plain `tsc` works too, with `shinro/tsconfig/emit`. So does any other bundler:
the generated router is a normal TypeScript module with relative imports.

## Configuration

Three keys, all JSON, in `shinro.config.json` or `package.json#shinro` — and
every one of them optional:

```jsonc
// shinro.config.json
{
  "routes": "src/routes",
  "app": "src/app.ts",
  "ignoredRouteFiles": [],
}
```

There is no config loader and no `jiti`/`unconfig` dependency, because nothing
left in the config needs to be code. `entry` and `build` belong to your bundler,
`basePath` is Hono's, and the output directory is always `.shinro` — a knob with
one working setting is not a knob. The adapters accept the same three keys inline
and they win over both files, so config-in-code stays available.

Server settings such as the port, hostname, signals, and shutdown behavior belong
in your application.

v0.1 supports one Shinro application per TypeScript project. Separate
applications in a monorepo use separate projects.

See the repository [specification](../../docs/SPEC.md) for the complete v0.1
contract, diagnostics, and test requirements.

## License

[MIT](./LICENSE) &copy; [Arik Chakma](https://x.com/imarikchakma)
