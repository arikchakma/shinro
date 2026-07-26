---
layout: ../layouts/Layout.astro
title: Configuration
description: Configure Shinro's app, route tree, build, base path, and generated RPC output.
---

# Configuration

Pass options to the single `shinro()` Vite plugin. Defaults are deliberately small and suit a conventional `src` directory.

```ts title="vite.config.ts"
import { shinro } from 'shinro';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    shinro({
      app: 'src/app.ts',
      entry: 'src/server.ts',
      routes: 'src/routes',
      basePath: '/',
    }),
  ],
});
```

## Route options

| Option              | Default      | Purpose                                    |
| ------------------- | ------------ | ------------------------------------------ |
| `routes`            | `src/routes` | Directory scanned for route modules        |
| `basePath`          | `/`          | Prefix applied to every generated URL      |
| `ignoredRouteFiles` | `[]`         | Route-relative `path.matchesGlob` patterns |

Additional exclusions apply to both route modules and directory middleware:

```ts title="vite.config.ts"
shinro({
  ignoredRouteFiles: ['internal/**', '**/*.draft.ts'],
});
```

## Build options

| Option            | Default      | Purpose                                |
| ----------------- | ------------ | -------------------------------------- |
| `build.outDir`    | `dist`       | Server build directory                 |
| `build.fileName`  | `server.mjs` | Configured server entry output         |
| `build.minify`    | `false`      | Minify the server build                |
| `build.sourcemap` | `false`      | Emit an inline source map when enabled |
| `build.unbundle`  | `true`       | Preserve the source module tree        |

The default unbundled build keeps dependencies external and produces output that is easy to inspect. Set `build.unbundle: false` for a self-contained server artifact.

## RPC options

RPC generation is enabled by default:

```ts title="vite.config.ts"
shinro({
  rpc: {
    enabled: true,
    outDir: '.shinro',
  },
});
```

The bundled TypeScript base config assumes `.shinro`. If `rpc.outDir` changes, merge the equivalent `rootDirs` and `include` entries into your project config; Shinro prints the required values.
