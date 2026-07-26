# Shinro API showcase

A runnable Node.js API demonstrating Shinro's route-authoring features in a
small, focused application.

```sh
vp run api#typegen
vp run api#dev
```

The server listens on `PORT`, defaulting to `3000`. File routes use the
configured `/v1` base path.

## Highlights

- static, index, nested dynamic, and catch-all file routes;
- every supported named HTTP method;
- JSON, query, and parameter validation;
- route-local and inherited directory middleware;
- a `(authed)` group directory that scopes middleware to `/v1/orders`, plus an
  escaped `[sitemap.xml].ts` route serving `/v1/sitemap.xml`;
- optional generated route and middleware type declarations;
- a chained Hono sub-router and a chained manual route;
- generated Hono RPC and client exports;
- a one-file Node build with application-owned graceful shutdown.

Type generation reports Shinro's documented sub-router boundary warning:
the root directory middleware runs around `/v1/admin`, but its response
types cannot be merged into every opaque route inside that sub-router.

Call the protected route with and without the demo credential:

```sh
curl http://localhost:3000/v1/protected
curl -H "authorization: Bearer demo" http://localhost:3000/v1/protected
```
