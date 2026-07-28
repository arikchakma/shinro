---
layout: ../layouts/Layout.astro
title: File routes
description: Map route module filenames to Hono URL patterns.
---

# File routes

Files under `src/routes` become Hono routes. Directories and filenames contribute URL segments, while a small set of conventions handles indexes, parameters, catch-alls, and pathless groups.

Each route module exports one handler tuple per HTTP method:

```ts title="src/routes/health.ts"
import { defineHandler } from 'shinro/app';

export const GET = defineHandler((c) => {
  return c.json({ ok: true as const }, 200);
});
```

Supported exports are `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, and `ALL`. A route file with no supported export is ignored with a warning.

## Basic mapping

| Route file                      | URL              |
| ------------------------------- | ---------------- |
| `src/routes/index.ts`           | `/`              |
| `src/routes/health.ts`          | `/health`        |
| `src/routes/api/users.ts`       | `/api/users`     |
| `src/routes/api/users/index.ts` | `/api/users`     |
| `src/routes/api/users/$id.ts`   | `/api/users/:id` |

`index` contributes no segment. Because `users.ts` and `users/index.ts` resolve to the same URL, use one spelling per endpoint.

## Dynamic and catch-all segments

A `$` prefix declares a required parameter. Parameter names must match `[A-Za-z_][A-Za-z0-9_]*` and be unique within the route.

```ts title="src/routes/users/$id.ts"
export const GET = defineHandler((c) => {
  return c.json({ id: c.req.param('id') }, 200);
});
```

`$...name` creates a catch-all and must be the final URL-contributing segment:

| Route file                     | URL                |
| ------------------------------ | ------------------ |
| `src/routes/files/$...path.ts` | `/files/:path{.+}` |

The generated Hono pattern requires at least one segment. Add `files/index.ts` when `/files` itself should also match.

## Route groups

A directory named `(name)` scopes middleware without contributing a URL segment:

```text
src/routes/(authed)/_middleware.ts
src/routes/(authed)/orders.ts       → /orders
src/routes/(authed)/billing.ts      → /billing
src/routes/health.ts                → /health
```

Groups are pathless, not ignored. Their routes and middleware stay active, and groups can nest.

## Sub-routers

Instead of method exports, a route file can default-export a chained Hono router:

```ts title="src/routes/admin.ts"
import { Hono } from 'hono';

export default new Hono()
  .get('/', (c) => c.json({ section: 'admin' }, 200))
  .get('/stats', (c) => c.json({ activeUsers: 42 }, 200));
```

This serves `/admin` and `/admin/stats`, both included in the generated client. The file owns the complete `/admin` namespace, so it cannot coexist with `src/routes/admin/**` or with a dynamic route that could match beneath it.

The routes must stay chained. An unassigned `router.get(...)` statement still registers at runtime, but Hono does not retain its schema, so the route could not appear in the client — Shinro rejects that shape rather than generating a client that quietly omits it.

## Static routes win

Shinro registers static routes before dynamic routes, and dynamic routes before catch-alls. The result is deterministic even when several patterns could match the same request.
