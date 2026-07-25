# Daroyan

This repository contains Daroyan, type-safe file routing and Hono RPC for
user-owned Node.js and Bun servers.

- Package and usage guide: [`packages/routes/README.md`](./packages/routes/README.md)
- File route conventions: [`docs/file-route-conventions.md`](./docs/file-route-conventions.md)
- Complete v0.1 contract: [`SPEC.md`](./SPEC.md)

## Workspace commands

```sh
vp install
vp check
vp test
vp run daroyan#build
```

Daroyan uses one Vite plugin:

```ts
export default defineConfig({
  plugins: [daroyan()],
});
```

The configured app remains an ordinary Hono instance, and the application
owns its listener and graceful shutdown:

```ts
const app = defineApp();

// Use normal Hono APIs.

export default app;
```
