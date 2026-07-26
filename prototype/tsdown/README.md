# Prototype: Shinro without a dev server

Structure and generated output only — nothing here runs, nothing is implemented.
Two trees:

- `app/` — what an application looks like when Shinro owns routing and nothing
  else. The runner is `tsx`/`bun`/`node`, the build is `tsdown`, both chosen by
  the app.
- `package/` — what `packages/shinro/src` looks like after the refactor. Files
  are signatures plus a note on what moved and what died.

## The shape

```
app/
├── package.json            imports: #shinro/routes  ← the load-bearing four lines
├── tsconfig.json           { "extends": "shinro/tsconfig" }  ← that's all of it
├── shinro.config.json      basePath, routes, app, rpc — all JSON, no loader
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
    ├── client.ts
    ├── rpc.ts
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

## What runs it

```sh
shinro typegen                  # once, before anything else
shinro typegen --watch          # regenerates on route-tree changes, restarts nothing

tsx watch src/server.ts         # or bun --watch, or node --watch --experimental-strip-types
tsdown                          # build; the plugin regenerates first
node dist/server.mjs
```

The `dev` script in `app/package.json` composes those with `concurrently` and a
blocking `shinro typegen` first, because without it the runner boots before
`.shinro/routes.ts` exists and fails to resolve `#shinro/routes`.

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
| `#shinro/routes` via `imports` | yes, natively | yes | yes | yes | yes |

`paths` would type-check clean and then crash under plain Node — the worst
failure shape available, since the thing that's wrong is a compiler option the
runner never reads. `imports` is part of ESM resolution itself, so every runner
supports it by definition, and TypeScript resolves it with no tsconfig
involvement at all.

The four lines in `package.json` are the one piece of boilerplate the redesign
adds. If that's the part you want gone, the move is to have `shinro typegen`
write the `imports` block itself on first run — `core/validate.ts` currently
just warns with the snippet.

## Open decisions this prototype takes a position on

- Config lives in `shinro.config.json` (or `package.json#shinro`). Once `entry`
  and `build` move to tsdown, everything left is JSON-serializable, so there's
  no jiti/unconfig dependency.
- `shinro/tsdown` and `shinro/vite` both ship, as optional peers. Keeping the
  Vite adapter costs ~20 lines and keeps `vp dev` projects working.
- No `shinro dev`.
- `format: 2` → `3` on the generated files, since `shinro.d.ts` disappearing and
  the specifier change are both breaking.
