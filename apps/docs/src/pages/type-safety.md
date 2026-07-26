---
layout: ../layouts/Layout.astro
title: End-to-end types
description: Use generated route type declarations and Shinro's typed Hono client.
---

# End-to-end types

Shinro derives runtime registration and RPC types from the same normalized route manifest. Server routes, parameters, middleware responses, and the client stay aligned as files change.

## Route type declarations

Generated `+types` imports are optional. Use one when a handler needs strict filename-derived parameter and path types:

```ts
// src/routes/users/$id.ts
import { defineHandler } from 'shinro/app';
import type { Route } from './+types/users/$id.ts';

export const GET = defineHandler<Route.Handler>((c) => {
  return c.json({ id: c.req.param('id') }, 200);
});
```

The import repeats the whole route path below `src/routes`, including any `(group)` directories. It names the file rather than the public URL.

## Project environment

Augment `ShinroEnv` once to share bindings and variables across the app, route handlers, and directory middleware:

```ts
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

Export the generated client factory from the API package:

```json
{
  "exports": {
    "./client": "./.shinro/client.ts",
    "./rpc": "./.shinro/rpc.ts"
  }
}
```

Consumers receive Hono's typed RPC client:

```ts
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
