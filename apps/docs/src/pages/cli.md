---
layout: ../layouts/Layout.astro
title: CLI
description: Generate, check, and watch the Shinro route tree from the command line.
---

# CLI

The `shinro` command writes `.shinro` from the route tree: the mountable Hono router, the route type declarations, the typed client, and the manifest.

```sh
shinro generate           # write .shinro from the route tree
shinro generate --watch   # for a runner that can do neither half itself
shinro generate --check   # compare against disk, write nothing, exit non-zero on drift
shinro generate --tree    # print the route tree as well
shinro init               # add the imports block, tsconfig, and scripts
```

Run any of them with `--help` for the flags.

## Generate

```sh
shinro generate
```

One line of output, because `generate` runs from `prepare` — on every install, in every CI job — and a project with a few hundred routes would print a few hundred lines nobody asked for.

```text
✓ wrote .shinro · 142 routes
```

Ask for the tree when you want it:

```text
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

Generation is atomic: files are assembled in a staging directory and promoted with `rename`, so a reader never sees a half-written module and a failure leaves the previous generation byte for byte. Files whose contents are unchanged are not rewritten at all, which is what keeps a watching runner from restarting in a loop.

## Development

```sh
node --watch --import shinro/watch src/server.ts
```

That is the whole dev loop, in one process. `shinro/watch` is a side-effecting subpath for `node --import`: it generates once — before the entry is resolved, which is why it must be `--import` and not an import inside a dev entry — and then keeps one debounced watcher on the routes directory.

Plain `--watch` is graph watching, and the graph is enough because the one thing it cannot see funnels through a file it can. A brand-new route file is invisible to a graph watcher, since nothing imports it yet; the watcher regenerates, `routes.ts` changes, and `routes.ts` _is_ in the graph through `#shinro/routes`, so Node restarts. One restart per real change.

Two alternatives, both one line:

```sh
# a directory restart instead of a resident watcher (macOS and Windows only:
# Node restricts --watch-path to those platforms)
node --watch --watch-path=src --import shinro/generate src/server.ts

# a runner with its own watcher
NODE_OPTIONS="--import shinro/generate" tsx watch --include "src/routes/**" src/server.ts
```

There is no `shinro dev`. Anything that spawned the runner would be a supervisor, and a supervisor owes you SIGTERM semantics, log multiplexing, and exit-code forwarding.

`shinro generate --watch` covers the remaining case: a runner that can neither watch a directory nor be given a preload. It generates once, synchronously, before it starts watching, and prints one line per save.

## Check

```sh
shinro generate --check
```

`--check` generates into memory and compares against disk. It writes nothing and exits non-zero on a route conflict, an invalid module, or a stale artifact.

```text
✗ Route conflict at "/api/users/:id"
    src/routes/api/users/$id.ts
    src/routes/api/users/$id/index.ts
```

This is the CI gate. Because no bundler is guaranteed to run, `generate` is the only moment a route conflict can be caught. It also fails on a stale `.shinro/`, which is what makes committing the generated directory a supported choice rather than a trap — and it tells an upgrade apart from a forgotten regeneration, because the artifacts carry the format number that wrote them.

Colour is dropped when stdout is not a TTY or `NO_COLOR` is set, so the output reads the same in a terminal, a pipe, and a CI log.

## Build

The app owns its build. Run `shinro generate` in a script before it, or let an adapter do it:

```ts title="tsdown.config.ts"
import { shinro } from 'shinro/tsdown';
import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/server.ts'],
  format: 'esm',
  outDir: 'dist',
  platform: 'node',
  unbundle: true,
  plugins: [shinro()],
});
```

The adapter does one thing: it regenerates in `buildStart`, before rolldown resolves the graph, so a build cannot ship stale routes. It is never load-bearing — delete it, run `shinro generate` in the script instead, and the output is byte-identical. `shinro/vite` is the same handful of lines for projects already on Vite or `vp`.

Plain `tsc` works too, with `shinro/tsconfig/emit`. So does any other bundler: the generated router is a normal TypeScript module with relative imports.

## Diagnostics

Shinro reports invalid route segments, conflicting URL patterns, unsupported handler exports, mounting mistakes, and TypeScript configuration gaps with the `[shinro]` prefix.

Diagnostics fail closed: ambiguous route trees and shapes that cannot be spread into Hono registrations are rejected before the server starts. Every conflict in a tree is reported at once rather than one per run.
