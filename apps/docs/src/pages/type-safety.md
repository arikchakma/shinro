---
layout: ../layouts/Layout.astro
title: End-to-end types
description: Use generated route type declarations and Shinro's typed Hono client.
---

# End-to-end types

Shinro derives runtime registration and RPC types from one route tree. Server routes, parameters, middleware responses, and the client stay aligned as files change, because the generated client's `AppType` is simply `typeof app`.

## Route type declarations

Generated `+types` imports are optional. Use one when a handler needs strict filename-derived parameter and path types:

```ts title="src/routes/users/$id.ts"
import { defineHandler } from 'shinro/app';
import type { Route } from './+types/users/$id.ts';

export const GET = defineHandler<Route.Handler>((c) => {
  return c.json({ id: c.req.param('id') }, 200);
});
```

The import repeats the whole route path below `src/routes`, including any `(group)` directories. It names the file rather than the public URL, so a basename like `$id.ts` that recurs across the tree still resolves to one route.

The declaration supplies the filename-derived path and parameter names. It does not validate requests at runtime — use a validator when validation is required. Note that an explicit type argument stops TypeScript inferring what follows it: under `Route.Handler`, a preceding validator still rejects bad requests, but it no longer types `c.req.valid()` or contributes its input to the generated client. Read validated input from the inferred form instead:

```ts title="src/routes/users/$id.ts"
const params = z.object({ id: z.string().min(1) });

export const GET = defineHandler(zValidator('param', params), (c) => {
  const { id } = c.req.valid('param');
  return c.json({ id }, 200);
});
```

Shinro cross-checks `"param"` schemas against the filename's parameters for any Hono validator — `zValidator`, `vValidator`, `sValidator`, and the rest share the same `factory("param", schema)` shape — and warns when the two disagree.

## Project environment

Augment `ShinroEnv` once to share bindings and variables across the app, route handlers, and directory middleware:

```ts title="src/env.d.ts"
declare module 'shinro/app' {
  interface ShinroEnv {
    Variables: {
      requestId: string;
    };
  }
}
```

You can also use Hono's native `ContextVariableMap` augmentation in the module that introduces a variable.

## Typed client

Shinro generates `.shinro/client.ts` on every run; there is no switch for it. Inside the app, import it through the subpath `init` wrote:

```ts title="src/api.ts"
import { defineClient } from '#shinro/client';
```

An API workspace can publish the same file to its consumers:

```json title="package.json"
{
  "exports": {
    "./client": "./.shinro/client.ts"
  }
}
```

Either way, what you get is Hono's typed RPC client:

```ts title="src/api.ts"
import { defineClient } from '@acme/api/client';

const client = defineClient('http://localhost:3000');
const response = await client.users[':id'].$get({
  param: { id: 'usr_123' },
});

if (response.status === 200) {
  const user = await response.json();
}
```

Response bodies narrow by status. Early responses returned by directory middleware are included in the same response union.

On a large app, a consumer of `./client` re-elaborates the whole chained server type. Hono documents that cost; past a few dozen routes, run `tsc --declaration` over `client.ts` and publish the emitted `.d.ts` so consumers elaborate nothing.
