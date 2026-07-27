# Prototype: Shinro without a dev server

Structure and generated output only — nothing here runs, nothing is implemented.
Two trees:

- `app/` — what an application looks like when Shinro owns routing and nothing
  else. The runner is `node`/`tsx`/`bun`, the build is `tsdown`, both chosen by
  the app.
- `package/` — what `packages/shinro/src` looks like after the refactor. Files
  are signatures plus a note on what moved and what died.

Revised against `docs/architecture-review.html`. What changed in this round is
listed at the bottom.

## The shape

```
app/
├── package.json            imports: #shinro/routes  ← the load-bearing four lines
├── tsconfig.json           { "extends": "shinro/tsconfig" }  ← that's all of it
├── shinro.config.json      routes, app, ignoredRouteFiles — all JSON, no loader
├── tsdown.config.ts        the app owns the build; shinro/tsdown adds codegen
├── src/
│   ├── server.ts           Shinro never touches this file
│   ├── app.ts              import { routes } from '#shinro/routes'
│   └── routes/
│       ├── _middleware.ts
│       ├── index.ts
│       ├── health.ts
│       └── users/
│           ├── index.ts
│           └── $id.ts
└── .shinro/                generated
    ├── routes.ts           relative imports with .ts — any runner can execute it
    ├── client.ts           the only place AppType exists
    ├── manifest.json
    └── types/src/routes/
        ├── +types/_middleware.d.ts
        ├── +types/index.d.ts
        ├── +types/health.d.ts
        └── users/+types/users/
            ├── index.d.ts
            └── $id.d.ts
```

`.shinro/shinro.d.ts` is gone. It existed only to make the bare `shinro/routes`
specifier type-check against a plugin-provided `resolveId`; package.json
`imports` replaces both halves.

`.shinro/rpc.ts` is gone too. `client.ts` derives `AppType` from `typeof app`,
and because `.route('/', routes())` merges the sub-router's schema into the
parent, that type is already the complete contract. A second generated module
re-registering every route was a second derivation of one thing, and two
derivations diverge. Projects that want the specifier can point a package export
at `client.ts`.

## What runs it

```sh
# dev — one process, no concurrently, no `shinro dev`
node --watch --watch-path=src --import shinro/generate src/server.ts

# build
tsdown                          # the adapter regenerates in buildStart
node dist/server.mjs

# CI
shinro generate --check && tsc --noEmit
```

### Why dev is one process

Three things have to be true at once, and each one is doing real work:

1. **`--import` runs to completion before the entry is resolved.** Generation
   finishes before anything resolves `#shinro/routes`. It has to be `--import`
   and not an import inside a `src/dev.ts`: ESM loads an entire graph before
   evaluating any of it, so an in-graph import would have `#shinro/routes`
   resolved *before* codegen ran — fine once `.shinro` exists, broken on a cold
   clone, which is the worst shape a bug can take.
2. **`--watch-path=src` watches the directory, not the graph.** A brand-new
   route file triggers a restart even though nothing imports it yet. No graph
   watcher can do this, which is the same gap `tsdown --watch` has.
3. **The restart re-runs the preload,** so the new route is registered.

Verified in this repo: adding a route file mid-run restarts once and the route
appears; editing a handler body restarts once.

**This only works because `emit` skips identical content.** With generation on
every restart, an unconditional write bumps the mtime of a file inside the
watched tree → restart → regenerate → write → restart, forever. Tested both
ways: unconditional writes loop indefinitely, hash-then-skip settles at exactly
one restart per real change. The `.shinro/` mtime invariant in SPEC §25 was
filed as a nicety; it is load-bearing.

Two caveats, both on the runner rather than on Shinro:

- `.ts` entries need Node ≥23.6 for unflagged type stripping (or 22.12 with
  `--experimental-strip-types`).
- Node's docs put `--watch-path` on macOS and Windows only — **verify on Linux**
  before documenting this as the default, since Docker-based dev is common.

The fallback for any graph-only runner is the same preload through
`NODE_OPTIONS`, with the routes directory added to the runner's watch list —
kept as `dev:tsx` in `app/package.json`:

```sh
NODE_OPTIONS="--import shinro/generate" tsx watch --include "src/routes/**" src/server.ts
```

`tsx --include` and `NODE_OPTIONS` pass-through are both unverified here. The
last resort, if neither holds, is two processes (`shinro generate --watch`
alongside the runner) — which is where this prototype started, and it is worth
avoiding: it needs a `concurrently` dependency, splits the logs, and puts route
diagnostics in a different pane from the crash they caused.

## What `tsdown` emits

```
dist/
├── server.mjs
├── app.mjs
├── .shinro/routes.mjs
└── routes/
    ├── _middleware.mjs
    ├── index.mjs
    ├── health.mjs
    └── users/
        ├── index.mjs
        └── _id.mjs
```

`#shinro/routes` is resolved at build time and never appears in `dist` —
same as the current `examples/api/dist/.shinro/routes.mjs`.

## On hiding `paths` in `shinro/tsconfig`

Verified against tsc, and the finding is better than expected. A base config in
`node_modules` normally can't express project-relative paths — `paths` resolves
relative to the file that *declares* it, so `".shinro/routes.ts"` looks in
`node_modules/shinro/.shinro/routes.ts`. But `${configDir}` (TS 5.5+) re-anchors
to the consuming project, and `packages/shinro/tsconfig.base.json` already uses
it for `rootDirs` and `include`. A bare `{ "extends": "shinro/tsconfig" }` with
no `compilerOptions` of its own type-checks a project using `rootDirs`-merged
`+types` declarations and a `paths`-mapped `shinro/routes`. Both confirmed with
negative controls.

So the base config genuinely can absorb the tsconfig boilerplate — and it should
keep doing that for `rootDirs` and `include`.

What it can't absorb is **runtime** resolution, which is why this prototype uses
`#shinro/routes` rather than a `paths` alias:

| specifier | tsc | tsx | bun | `node --experimental-strip-types` | rolldown |
| --- | --- | --- | --- | --- | --- |
| `shinro/routes` via `paths` | yes | reads tsconfig `paths`, `${configDir}` support unverified | same | **no** — Node does no path mapping, ever | reads tsconfig, needs wiring |
| `shinro/routes` via package `exports` | n/a | n/a | n/a | **impossible** — targets can't escape the published package | n/a |
| `#shinro/routes` via `imports` | yes, natively | yes | yes | yes | yes |
| `@acme/api/routes` via self-reference | yes | yes | yes | yes | yes |

`paths` would type-check clean and then crash under plain Node — the worst
failure shape available, since the thing that's wrong is a compiler option the
runner never reads. `imports` is part of ESM resolution itself, so every runner
supports it by definition, and TypeScript resolves it with no tsconfig
involvement at all.

The self-reference row is the honest alternative: a package with a `name` and an
`exports` map can import itself by name, so `@acme/api/routes` needs no `#` and
no plugin. It is arguably better named — those are the app's routes, not
Shinro's — but the specifier differs per project, so the docs can't show one
canonical import line. Worth a decision rather than an omission.

**A relative import always works and must never warn.** `import { routes } from
'../.shinro/routes.ts'` needs no package.json at all. `#shinro/routes` is the
documented default only because it survives moving `app.ts`.

The four lines in `package.json` are the one piece of boilerplate the redesign
adds. `shinro init` writes them; `core/validate.ts` warns with the snippet when
they're missing or point somewhere other than `.shinro`.

## Open decisions this prototype takes a position on

- Config lives in `shinro.config.json` (or `package.json#shinro`). Once `entry`
  and `build` move to tsdown, everything left is JSON-serializable, so there's
  no jiti/unconfig dependency. Adapters accept inline options that win over both
  files, so config-in-code stays available without a loader.
- Three keys, no toggles: `routes`, `app`, `ignoredRouteFiles`. `client.enabled`
  is gone because off is not a state worth supporting — `client.ts` is one
  type-only file and it's why most people are here. `client.outDir` is gone
  because it never worked: `shinro/tsconfig` hardcodes `${configDir}/.shinro` in
  `rootDirs` and `include`, so any other value type-checks against declarations
  TypeScript can't find. `.shinro` is fixed, and now says so.
- `shinro/tsdown` and `shinro/vite` both ship, as optional peers. Keeping the
  Vite adapter costs ~20 lines and keeps `vp dev` projects working. Neither is
  ever load-bearing: delete the plugin, run `shinro generate` in a script, get
  identical output.
- No `shinro dev`. The preload plus `node --watch` covers it; anything that
  spawns the runner is `DevelopmentProcess` with a friendlier name.
- `basePath` is Hono's. `defineApp().basePath('/v1')` prefixes manual routes and
  file routes alike and stays in the schema, so the generated client follows it.
  The config key is gone, and with it the seam where an app hand-wrote `/v1` on
  its manual routes with nothing checking the two halves agreed.
- Two shipped tsconfigs: `shinro/tsconfig` (check-only, `noEmit`) and
  `shinro/tsconfig/emit` (`rewriteRelativeImportExtensions`, `nodenext`). One
  config made "build it however you want" false for plain `tsc`.
- `shinro generate`, not `shinro typegen` — `routes.ts` is runtime code, and the
  old verb told people the router was a type artifact. `typegen` stays as an
  undocumented alias.
- `format: 2` → `3` on the generated files, since `shinro.d.ts` disappearing and
  the specifier change are both breaking.

## Changed in this revision

| Review | Change |
| --- | --- |
| §5 | `dev` is one process: `node --watch --watch-path` + `--import shinro/generate`. `concurrently` dropped. New `package/src/generate.ts`; the loop hazard written into `core/emit.ts`. |
| §6.1 | Added `package/tsconfig.emit.json` and the `./tsconfig/emit` export. |
| §6.2 | Deleted `app/.shinro/rpc.ts`, `#shinro/rpc`, and the `./rpc` export. Config `rpc` dropped outright, not renamed. |
| §6.3 | `--check` on the CLI; `cli/typegen.ts` → `cli/generate.ts`. |
| §6.4 | `basePath` out of config, into `defineApp().basePath('/v1')`. Generated paths and `+types` lost the `/v1` prefix. |
| §7 | `typegen` → `generate` everywhere, alias retained. |
| §3 | `watch` added to the public surface; adapters take inline config; "never load-bearing" written into both adapters. |
| §2 | Self-reference and package-`exports` rows added to the resolution table; the relative-import escape hatch made explicit. |
