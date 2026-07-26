---
layout: ../layouts/Layout.astro
title: CLI
description: Generate Shinro route and RPC types from the command line.
---

# CLI

The `shinro` command generates the route manifest, mountable Hono router, route type declarations, and typed client artifacts for the current project.

## Generate types

Run type generation before a standalone type check or in workflows that do not start the Vite development server:

```sh
shinro typegen
```

In a workspace where the package itself must build first:

```json title="package.json"
{
  "scripts": {
    "typegen": "vp run shinro#build && shinro typegen",
    "check": "vp run typegen && vp check"
  }
}
```

## Development

`vp dev` runs Vite with the Shinro plugin. Structural changes, including adding, moving, or removing a route, regenerate routing and client types during development.

```sh
vp dev
```

## Build

Build through the configured Vite pipeline:

```sh
vp build
```

The default output keeps the source module tree unbundled under `dist`. Configure `build.unbundle: false` when deployment needs a single bundled server entry.

## Diagnostics

Shinro reports invalid route segments, conflicting URL patterns, unsupported handler exports, mounting mistakes, and generated TypeScript configuration requirements with the `[shinro]` prefix.

Diagnostics are designed to fail close: ambiguous route trees and shapes that cannot be spread into Hono registrations are rejected before the server starts.
