# Shinro API showcase

A runnable Node.js API demonstrating Shinro's route-authoring features in a
small, focused application.

```sh
vp run api#generate   # write .shinro from the route tree
vp run api#dev        # node --watch --import shinro/watch src/server.ts
```

One process, no `shinro dev`, no supervisor: the preload generates before the
entry resolves and then watches the routes directory, and Node owns the watching,
the restarting, and the signals. The server listens on `PORT`, defaulting to
`3000`. The `/v1` prefix is Hono's — `defineApp().basePath('/v1')` in `src/app.ts`
— so it covers the manual route and every file route alike, and the generated
client's URLs follow it for free.

## How it is wired

Four things do the whole job:

| Where                    | What                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json` `imports` | `#shinro/routes` → `./.shinro/routes.ts`. Part of ESM resolution, so tsc, node, tsx, bun, and rolldown all resolve it without configuration. |
| `tsconfig.json`          | `{ "extends": "shinro/tsconfig" }`, which carries `rootDirs` and `include` for the generated `+types` declarations.                          |
| `vite.config.ts` `pack`  | The app owns its build; the `shinro/tsdown` plugin regenerates in `buildStart` so a build cannot ship stale routes.                          |
| `package.json` scripts   | `shinro generate` in `prepare`, `shinro generate --check` in `check`.                                                                        |

## Highlights

- static, index, nested dynamic, and catch-all file routes;
- every supported named HTTP method;
- JSON, query, and parameter validation;
- route-local and inherited directory middleware;
- a `(authed)` group directory that scopes middleware to `/v1/orders`, plus an
  escaped `[sitemap.xml].ts` route serving `/v1/sitemap.xml`;
- a colocated `resources/-resource.ts` holding the schemas, type, and fixtures
  its two neighbouring route files share, excluded from routing by its `-` prefix;
- optional generated route and middleware type declarations;
- a chained Hono sub-router and a chained manual route;
- a generated typed client exported as `@shinro/api/client`;
- a `vp pack` build whose `dist` mirrors the source tree, with
  application-owned graceful shutdown.

Generation warns about `admin.ts`: it mounts a sub-router, so an early response
from the root middleware would be missing from the client. Harmless here, since
that middleware only sets a header and always calls `next()`.

Call the protected route with and without the demo credential:

```sh
curl http://localhost:3000/v1/protected
curl -H "authorization: Bearer demo" http://localhost:3000/v1/protected
```
