---
layout: ../layouts/Layout.astro
title: Installation
description: Install Shinro in a Hono application and wire it up with shinro init.
---

# Installation

Shinro is a generator with a CLI, not a plugin. Install Hono and Shinro, then add the adapter for the runtime that starts your server.

```sh
vp add hono shinro
```

`shinro/app` is imported by your route files, so `shinro` is a dependency rather than a dev dependency.

Node.js applications also need Hono's Node adapter:

```sh
vp add @hono/node-server
```

Bun applications can use `Bun.serve()` directly.

## Wire it up

```sh
shinro init
```

`init` is idempotent, prints what it changed, and merges into what is already there. It writes three things, and there is nothing else to configure.

```json title="package.json"
{
  "imports": {
    "#shinro/routes": "./.shinro/routes.ts",
    "#shinro/client": "./.shinro/client.ts"
  },
  "scripts": {
    "dev": "node --watch --watch-preserve-output --import shinro/watch src/server.ts",
    "prepare": "shinro generate",
    "check": "shinro generate --check && tsc --noEmit"
  }
}
```

The `imports` block is the load-bearing part, and it is deliberately not a plugin: subpath imports are part of ESM resolution, so `#shinro/routes` resolves in `node`, `tsx`, `bun`, `rolldown`, and TypeScript by construction rather than because a bundler was configured.

A relative import works too and is never warned about — `import { routes } from '../.shinro/routes.ts'` needs no `package.json` entry at all. `#shinro/routes` is the documented default only because it survives moving `app.ts`.

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

The base config sets `moduleResolution`, import-extension behavior, `rootDirs`, and the include patterns the generated `+types` declarations need. It uses `${configDir}`, so a base config living in `node_modules` still expresses paths relative to your project.

`shinro/tsconfig` is check-only: `noEmit` is what makes `allowImportingTsExtensions` legal. A project that wants plain `tsc` to _emit_ extends `shinro/tsconfig/emit` instead, which swaps `noEmit` for `rewriteRelativeImportExtensions` so the generated `./x.ts` specifiers become `./x.js` in the output.

## Generated output

Shinro always generates into `.shinro`. Ignore it, or commit it and let `shinro generate --check` keep it honest — both are supported.

```text title=".gitignore"
.shinro/
dist/
```

With that in place, start the dev loop:

```sh
node --watch --watch-preserve-output --import shinro/watch src/server.ts
```

One process, no supervisor. The [CLI](/cli) page covers the rest of the commands.
