---
layout: ../layouts/Layout.astro
title: Directory middleware
description: Apply deterministic, typed middleware to a subtree of Shinro routes.
---

# Directory middleware

`_middleware.ts` applies to the route at its directory URL and every descendant. A file can export one or more Hono middleware handlers.

```ts title="src/routes/api/_middleware.ts"
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

## Inheritance order

For `/api/users`, middleware runs from the route root toward the leaf:

```text
src/routes/_middleware.ts
src/routes/api/_middleware.ts
src/routes/api/users.ts
```

Shinro flattens this chain onto each named route. Typed early responses from middleware, such as an authentication `401`, therefore become part of that route's RPC response union.

## Hono's own middleware

The tuple takes any Hono middleware, not just handlers written against the project env:

```ts title="src/routes/api/_middleware.ts"
import { bearerAuth } from 'hono/bearer-auth';
import { defineMiddleware } from 'shinro/app';

export default defineMiddleware(bearerAuth({ token: process.env.API_TOKEN! }));
```

One caveat: `cors()`, `logger()`, and the rest of the middleware Hono types against `any` will erase the env of an inline handler sharing their tuple. Give those a `_middleware.ts` of their own, or mount them on the base app, where they cover unmatched requests too.

Hono's typed overloads stop at a path plus ten handlers. A route that would exceed the limit once its directory middleware are inlined has them composed into a single slot instead, which keeps the route's validated request and response types at the cost of those middleware's early responses. Shinro warns when it does this, and fails with the offending route when even composition cannot fit.

## Around a sub-router

A route file that default-exports a Hono sub-router is mounted, not registered handler by handler, and Hono copies a mounted sub-router's schema exactly as the file wrote it. Directory middleware still wrap it at runtime, but an early response they return cannot reach the generated client for the routes inside it. Shinro warns when this applies; it only matters if the middleware can respond before calling `next()`.

## Unmatched requests

Directory middleware runs only when a route matches. A request to `/api/does-not-exist` goes directly to the app's not-found handler, without running `src/routes/api/_middleware.ts`.

Cross-cutting concerns that must cover every request belong on the base Hono app:

```ts title="src/app.ts"
const app = defineApp()
  .use('*', cors())
  .use('*', requestId())
  .route('/', routes());
```

Use directory middleware for route-scoped behavior such as authenticating one section of the API.

## Scope with groups

Route groups let selected sibling routes share middleware without changing their public URLs:

```text
src/routes/(authed)/_middleware.ts
src/routes/(authed)/orders.ts       → /orders, authenticated
src/routes/(authed)/billing.ts      → /billing, authenticated
src/routes/health.ts                → /health, public
```

Routes cannot opt out of middleware inherited from their directory. That keeps behavior visible from the file tree.
