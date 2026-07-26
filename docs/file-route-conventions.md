# File route conventions

Shinro turns files under `src/routes` into Hono routes. This guide covers every
filename convention: how files map to URLs, which files Shinro ignores, and how
to escape reserved characters.

URLs follow the directory structure. Each directory and filename contributes
one segment unless one of the conventions below changes its meaning.

## Setup

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { shinro } from 'shinro';

export default defineConfig({
  plugins: [shinro()],
});
```

Options that affect routing:

- `routes` — the routes directory, relative to the project root. Defaults to
  `src/routes`.
- `basePath` — a prefix applied to every generated URL, so `basePath: '/v1'`
  serves `src/routes/health.ts` at `/v1/health`. It is not a filename
  convention; every example below shows the path before the prefix.
- `ignoredRouteFiles` — additional exclusions expressed as `path.matchesGlob`
  globs relative to the routes directory.

## Routing conventions

### Basic routes

A filename is a URL segment, and the extension is dropped.

| Route file             | URL       |
| ---------------------- | --------- |
| `src/routes/index.ts`  | `/`       |
| `src/routes/health.ts` | `/health` |
| `src/routes/about.ts`  | `/about`  |

Each route file exports one handler per HTTP method:

```ts
// src/routes/health.ts
import { defineHandler } from 'shinro/app';

export const GET = defineHandler((c) => c.json({ ok: true }, 200));
```

### Index routes

`index` contributes no URL segment, so `index.ts` serves its directory's URL.

| Route file                      | URL          |
| ------------------------------- | ------------ |
| `src/routes/index.ts`           | `/`          |
| `src/routes/api/users/index.ts` | `/api/users` |

`src/routes/api/users.ts` serves the same URL, so the two spellings conflict —
pick one per URL. Use the directory form when the URL has children.

### Nested routes

Each nested directory contributes one URL segment.

| Route file                    | URL              |
| ----------------------------- | ---------------- |
| `src/routes/api/users.ts`     | `/api/users`     |
| `src/routes/api/users/$id.ts` | `/api/users/:id` |

A `.` in a filename is an ordinary character, allowing a route to serve a URL
with an extension:

| Route file                   | URL             |
| ---------------------------- | --------------- |
| `src/routes/sitemap.xml.ts`  | `/sitemap.xml`  |
| `src/routes/openapi.json.ts` | `/openapi.json` |

### Dynamic segments

A `$` prefix declares a required Hono parameter. Directories and files follow
the same rule.

| Route file                         | URL                   |
| ---------------------------------- | --------------------- |
| `src/routes/users/$id.ts`          | `/users/:id`          |
| `src/routes/api/$version/users.ts` | `/api/:version/users` |
| `src/routes/$org/$repo/index.ts`   | `/:org/:repo`         |

```ts
// src/routes/users/$id.ts
export const GET = defineHandler((c) => c.json({ id: c.req.param('id') }, 200));
```

A parameter name must match `[A-Za-z_][A-Za-z0-9_]*` and must be unique within
one route, so `users/$id/posts/$id.ts` is rejected.

For a typed `params` object and the route's own path type, import the
generated type declaration:

```ts
import type { Route } from './+types/users/$id.ts';

export const GET = defineHandler<Route.Handler>((c) => /* ... */);
```

The specifier repeats the route's whole path below `src/routes`, which is what
makes it unambiguous — every `$id.ts` in the tree would otherwise import from an
identical-looking path. A `(group)` directory stays in the specifier even though
it contributes nothing to the URL.

### Catch-all segments

`$...name` becomes Hono's `:name{.+}`, matching one or more segments. It must
be the last segment that contributes to the URL.

| Route file                     | URL                |
| ------------------------------ | ------------------ |
| `src/routes/files/$...path.ts` | `/files/:path{.+}` |

`{.+}` requires at least one segment, so `/files/a/b.txt` matches but `/files`
does not. Add `src/routes/files/index.ts` to serve the bare path. Catch-alls
must have names. Handle project-wide 404 responses on the Hono app with
`app.notFound(...)`, not in the route tree.

### Route groups

A directory named `(name)` contributes directory-middleware ancestry but no
URL segment. Use it to apply middleware to selected sibling routes without
changing their URLs.

```text
src/routes/(authed)/_middleware.ts   ← wraps the two routes below
src/routes/(authed)/orders.ts        → /orders
src/routes/(authed)/billing.ts       → /billing
src/routes/health.ts                 → /health, unwrapped
```

- A group is **pathless, not ignored**. Its routes and its `_middleware.ts`
  are live; only its name is absent from the URL.
- Groups nest. `(a)/(b)/x.ts` serves `/x` and inherits both middleware files.
- `(a)/index.ts` serves the group's parent URL.
- A group name never reaches a URL, so it cannot declare a parameter. `($id)`
  is rejected, as are `()` and an unbalanced `(authed`.
- A **file** named `(foo).ts` is rejected. A file has no descendants to group,
  and treating it as a group would alias it onto its parent's URL. Make it a
  directory, or write `[(foo)].ts` to serve `/(foo)` literally.
- Because `ignoredRouteFiles` patterns match the on-disk path, a pattern must
  include the group directory even though no URL does: `'(internal)/**'`, not
  `'internal/**'`.

### Directory middleware

`_middleware.ts` applies to the route at its directory's URL and every
descendant, stacking from the route root toward the leaf:

```text
src/routes/_middleware.ts
src/routes/api/_middleware.ts
src/routes/api/users.ts
```

Inheritance follows filesystem containment and has no per-route opt-out: a
route inside a middleware directory is always wrapped by it. To cover only
some sibling routes, place them under a `(name)` directory.

Shinro flattens the chain onto each named route, so a typed early middleware
response, such as `401`, enters that route's RPC response union. Directory
middleware therefore runs only when a route matches. Concerns that must see
every request, such as CORS, belong on the base app.

### Escaping special characters

Wrap text that would otherwise be interpreted as route syntax in `[...]` to
emit it literally.

| Route file                     | URL             |
| ------------------------------ | --------------- |
| `src/routes/[sitemap.xml].ts`  | `/sitemap.xml`  |
| `src/routes/[(foo)].ts`        | `/(foo)`        |
| `src/routes/[(foo)]/orders.ts` | `/(foo)/orders` |
| `src/routes/[$]id.ts`          | `/$id`          |
| `src/routes/v[$]1.ts`          | `/v$1`          |
| `src/routes/[index].ts`        | `/index`        |
| `src/routes/[[weird]].ts`      | `/[weird]`      |

- An escape makes its whole segment static: the segment is never read as a
  parameter, a group, or an index.
- A `[` matches the next `]`. An unmatched `[` is an ordinary character, which
  is why `[[weird]]` resolves to `[weird]`.
- A segment that both looks dynamic and contains an escape is rejected.
  `$id[.pdf].ts` would reach Hono as `:id.pdf` and be read as a parameter
  named `id.pdf`, so it fails instead.
- A resolved segment may not contain `:`, `{`, `}`, `*`, or `?`. Those are
  Hono path syntax and cannot be served literally, so `[:]id.ts` is rejected
  rather than quietly registering a parameter.
- Escaping only overrides URL conventions. It does not decide whether a file
  is a route: the exclusions below test the name on disk, and a name starting
  with `[` was never excluded, so `[_]internal.ts` does serve `/_internal`.
- A literal parenthesis in a **directory** name is reachable only through an
  escape, because bare parentheses there always mean grouping.

Dots need no escape, so `[sitemap.xml].ts` could also be written
`sitemap.xml.ts`. The escaped spelling states the intent.

### Files that are not routes

These are skipped before any URL is derived:

- `_middleware.ts`, except in its reserved middleware role;
- any other basename beginning with `_`;
- dotfiles, and anything under a dot-directory;
- `*.d.ts`;
- `*.test.*` and `*.spec.*`;
- anything under `__tests__`, `__fixtures__`, or `+types`.

Project-specific exclusions go in `ignoredRouteFiles`. A match excludes both
route modules and `_middleware.ts`:

```ts
shinro({
  ignoredRouteFiles: ['internal/**', '**/*.draft.ts'],
});
```

Built-in exclusions always apply and cannot be re-enabled.

Every other file in a route directory is a route at its own URL, so a
colocated helper needs the `_` prefix:

```text
src/routes/admin/index.ts     → /admin
src/routes/admin/stats.ts     → /admin/stats
src/routes/admin/_query.ts     not a route
```

### Sub-routers

A route file can default-export a chained Hono router instead of method
exports:

```ts
// src/routes/admin.ts
export default new Hono()
  .get('/', (c) => c.json({ section: 'admin' }, 200))
  .get('/stats', (c) => c.json({ activeUsers: 42 }, 200));
```

That file then owns the whole `/admin` namespace, so it cannot coexist with
`src/routes/admin/**` or with a dynamic route that could match beneath it.

### Conflicts

Generation fails when two routes produce the same URL (`users.ts` and
`users/index.ts`), when dynamic routes have equivalent matching shapes
(`users/$id.ts` and `users/$slug.ts`), or when a route enters a sub-router's
namespace. The diagnostic names both files and the normalized URL. Because a
group contributes no URL segment, files at different depths can collapse onto
one URL: `(authed)/orders.ts` and `orders.ts` conflict.

## Full mapping reference

| Route file                         | URL                   |
| ---------------------------------- | --------------------- |
| `src/routes/index.ts`              | `/`                   |
| `src/routes/health.ts`             | `/health`             |
| `src/routes/api/users.ts`          | `/api/users`          |
| `src/routes/api/users/index.ts`    | `/api/users`          |
| `src/routes/api/users/$id.ts`      | `/api/users/:id`      |
| `src/routes/api/$version/users.ts` | `/api/:version/users` |
| `src/routes/files/$...path.ts`     | `/files/:path{.+}`    |
| `src/routes/(authed)/orders.ts`    | `/orders`             |
| `src/routes/(authed)/index.ts`     | `/`                   |
| `src/routes/[sitemap.xml].ts`      | `/sitemap.xml`        |
| `src/routes/[(foo)].ts`            | `/(foo)`              |
| `src/routes/sitemap.xml.ts`        | `/sitemap.xml`        |

Static routes register before dynamic routes, which register before
catch-alls. Generated RPC URLs are canonicalized without a trailing slash,
except `/`.

## Unsupported

Shinro deliberately omits these filename conventions:

- **Dot delimiters.** `reports.monthly.ts` serves `/reports.monthly`. Use a
  directory to nest.
- **Optional segments.** There is no way to spell "this segment may be
  absent"; parentheses mean a group, and Hono has no optional parameter.
  Write both routes.
- **Zero-segment catch-alls.** `$...path` needs at least one segment, so pair
  it with an `index.ts` when the bare path should respond too.
- **A 404 route.** Unmatched requests belong to `app.notFound(...)` on your
  Hono app, not to a file.
- **Opting out of directory middleware.** A route inside a middleware
  directory is always wrapped by it. Move the covered routes into a `(name)`
  group instead.
