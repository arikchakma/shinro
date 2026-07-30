---
layout: ../layouts/Layout.astro
title: File conventions
description: Complete reference for Shinro route filenames, groups, escaping, and ignored files.
---

# File conventions

Shinro maps files under the configured routes directory to Hono paths. Every directory and filename contributes one segment unless a convention changes its meaning.

## Mapping reference

| File                            | Result             |
| ------------------------------- | ------------------ |
| `src/routes/index.ts`           | `/`                |
| `src/routes/health.ts`          | `/health`          |
| `src/routes/api/users/index.ts` | `/api/users`       |
| `src/routes/users/$id.ts`       | `/users/:id`       |
| `src/routes/files/$...path.ts`  | `/files/:path{.+}` |
| `src/routes/(authed)/orders.ts` | `/orders`          |
| `src/routes/[sitemap.xml].ts`   | `/sitemap.xml`     |
| `src/routes/[index].ts`         | `/index`           |
| `src/routes/[(foo)].ts`         | `/(foo)`           |

## Reserved forms

- `index` contributes no URL segment.
- `$name` declares a required parameter.
- `$...name` declares a final catch-all parameter matching one or more segments.
- `(name)` directories are pathless route groups.
- `-name` files and directories are excluded from routing.
- `_middleware.ts` wraps matching routes in its directory and descendants.
- `[value]` emits `value` literally instead of interpreting route syntax.

Parameters must match `[A-Za-z_][A-Za-z0-9_]*`. A route cannot repeat the same parameter name or put a URL-contributing segment after a catch-all.

## Escaping

Wrap a convention-looking value in brackets when it should be static:

| File                      | URL        |
| ------------------------- | ---------- |
| `src/routes/[$]id.ts`     | `/$id`     |
| `src/routes/[index].ts`   | `/index`   |
| `src/routes/[[weird]].ts` | `/[weird]` |

An escape makes the entire segment static. Dynamic segments containing an escape and resolved segments containing Hono path syntax are rejected rather than silently reinterpreted.

## Ignored files

Shinro ignores:

- files and directories beginning with `-`;
- files beginning with `_` or `.`, except `_middleware.ts`;
- declaration files and test/spec files;
- files below `__tests__`, `__fixtures__`, `.dot-directories`, or `+types`;
- files matched by `ignoredRouteFiles`.

A `(group)` directory is not ignored. Its routes and middleware remain active even though its name is absent from the URL.

## Colocation

A leading `-` excludes a file or directory from routing, so whatever a route needs can live next to it:

```text
src/routes/
├── posts.ts          // /posts
├── -post-schema.ts   // ignored
└── -queries/         // ignored, with everything below it
    ├── list-posts.ts
    └── insert-post.ts
```

Nothing inside a `-` directory is routed, including a `_middleware.ts`, so a colocated subtree adds no middleware to the routes around it. Escape the prefix to serve a URL segment that really starts with a dash: `[-]well-known.ts` serves `/-well-known`.

## Conflict rules

Two files cannot resolve to the same normalized URL pattern. This includes alternate index spellings such as `users.ts` and `users/index.ts`, and shapes that differ only in parameter name, such as `users/$id.ts` and `users/$slug.ts`.

A file that default-exports a sub-router owns its whole mount namespace, so nothing else may serve a URL beneath it. Every conflict in a tree is reported together, each one listing the files involved.

Registration order is always:

1. static routes;
2. dynamic routes;
3. catch-all routes.

The order is deterministic across filesystems and operating systems.
