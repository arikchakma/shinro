---
layout: ../layouts/Layout.astro
title: Installation
description: Install and configure Shinro in a Hono application.
---

# Installation

Shinro is a Vite plugin for Hono applications. Install Hono and Shinro, then add the adapter for the runtime that starts your server.

```sh
vp add hono
vp add -D shinro
```

Node.js applications also need Hono's Node adapter:

```sh
vp add @hono/node-server
```

Bun applications can use `Bun.serve()` directly.

## Add the plugin

Add `shinro()` to the Vite config. This is the only routing integration; there is no separate Node, Bun, RPC, or lifecycle plugin.

```ts title="vite.config.ts"
import { shinro } from 'shinro';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [shinro()],
});
```

The plugin discovers routes, writes generated declarations and router code, refreshes structural route changes during development, and builds the configured server entry.

## Configure TypeScript

Extend the base config shipped with Shinro:

```json title="tsconfig.json"
{
  "extends": "shinro/tsconfig",
  "compilerOptions": {
    "paths": {
      "~/*": ["./src/*"]
    }
  }
}
```

The base config sets `moduleResolution`, import-extension behavior, `rootDirs`, and the generated-file include patterns. This makes `shinro/app`, `shinro/routes`, `shinro/client`, and `shinro/rpc` resolve without hand-written aliases.

## Ignore generated output

Shinro writes its working files to `.shinro` by default. Keep generated and build output out of version control:

```text title=".gitignore"
.shinro/
dist/
```

After configuration, start the Vite development server normally:

```sh
vp dev
```
