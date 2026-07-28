---
layout: ../layouts/Layout.astro
title: Configuration
description: Point Shinro at your app and route tree with three optional JSON keys.
---

# Configuration

Three keys, all JSON, in `shinro.config.json` or `package.json#shinro` — and every one of them optional.

```json title="shinro.config.json"
{
  "routes": "src/routes",
  "app": "src/app.ts",
  "ignoredRouteFiles": []
}
```

| Option              | Default      | Purpose                                    |
| ------------------- | ------------ | ------------------------------------------ |
| `routes`            | `src/routes` | Directory scanned for route modules        |
| `app`               | `src/app.ts` | Module that default-exports the Hono app   |
| `ignoredRouteFiles` | `[]`         | Route-relative `path.matchesGlob` patterns |

There is no config loader and no `jiti`/`unconfig` dependency, because nothing left in the config needs to be code. An unknown key is a typo worth naming, so Shinro warns about it rather than ignoring it.

## Excluding files

`ignoredRouteFiles` patterns are matched against the path below the routes directory, and apply to route modules and directory middleware alike.

```json title="shinro.config.json"
{
  "ignoredRouteFiles": ["internal/**", "**/*.draft.ts"]
}
```

Reserved names are excluded without configuration — see [file conventions](/file-conventions) for the full list.

## Config in code

The build adapters accept the same three keys inline, and they win over both files. Use this when you would rather not keep a `shinro.config.json`:

```ts title="tsdown.config.ts"
plugins: [shinro({ routes: 'src/api' })];
```

The precedence is: adapter options, then `shinro.config.json`, then `package.json#shinro`, then the defaults. Defining configuration in both files at once warns; keep one place to look.

## What is not configurable

| Not an option    | Where it lives instead                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `entry`, `build` | Your bundler. The app owns its build; the adapter only regenerates before it runs.           |
| `basePath`       | Hono's own `defineApp().basePath('/v1')`, so the generated client's URLs follow it for free. |
| Output directory | Always `.shinro`. The shipped tsconfig hardcodes it in `rootDirs` and `include`.             |
| RPC generation   | Always on. `client.ts` is one type-only file that costs nothing to emit.                     |

Server settings such as the port, hostname, signals, and shutdown behavior belong in your application.

v0.1 supports one Shinro application per TypeScript project. Separate applications in a monorepo use separate projects.
