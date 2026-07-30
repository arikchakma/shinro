import { expect, test } from 'vite-plus/test';

import { APP_MODULE, GET_ROUTE, middleware, withProject } from './helpers.ts';

test('a filename derives the URL it serves', async () => {
  await withProject('urls', async (project) => {
    await project.write('src/routes/index.ts', GET_ROUTE);
    await project.write('src/routes/health.ts', GET_ROUTE);
    await project.write('src/routes/users/index.ts', GET_ROUTE);
    await project.write('src/routes/users/$id.ts', GET_ROUTE);
    await project.write('src/routes/files/$...path.ts', GET_ROUTE);
    await project.write('src/routes/[sitemap.xml].ts', GET_ROUTE);
    await project.write('src/routes/(authed)/orders.ts', GET_ROUTE);
    await project.generate();

    // Registration order, not disk order: static wins over dynamic, dynamic over
    // catch-all, and ties break alphabetically so the emitted router is stable.
    expect(
      (await project.manifest()).routes.map((entry) => entry.path)
    ).toEqual([
      '/',
      '/health',
      '/orders',
      '/sitemap.xml',
      '/users',
      '/users/:id',
      '/files/:path{.+}',
    ]);
  });
});

test('routes register in static, dynamic, then catch-all priority', async () => {
  await withProject('priority', async (project) => {
    await project.write('src/routes/files/$...path.ts', GET_ROUTE);
    await project.write('src/routes/files/$id.ts', GET_ROUTE);
    await project.write('src/routes/files/latest.ts', GET_ROUTE);
    await project.generate();

    expect(
      (await project.manifest()).routes.map((entry) => entry.path)
    ).toEqual(['/files/latest', '/files/:id', '/files/:path{.+}']);
  });
});

test('conflicting file routes fail generation naming both source files', async () => {
  await withProject('conflict', async (project) => {
    await project.write('src/routes/users.ts', GET_ROUTE);
    await project.write('src/routes/users/index.ts', GET_ROUTE);

    await expect(project.generate()).rejects.toThrow(
      /\[shinro\][\s\S]*\/users[\s\S]*(?:users\.ts[\s\S]*users\/index\.ts|users\/index\.ts[\s\S]*users\.ts)/
    );
  });
});

test('equivalent dynamic shapes conflict even when parameter names differ', async () => {
  await withProject('dynamic-shape', async (project) => {
    await project.write('src/routes/users/$id.ts', GET_ROUTE);
    await project.write('src/routes/users/$slug.ts', GET_ROUTE);

    await expect(project.generate()).rejects.toThrow(
      /\/users\/:id[\s\S]*(?:\$id\.ts[\s\S]*\$slug\.ts|\$slug\.ts[\s\S]*\$id\.ts)/
    );
  });
});

test('a default sub-router owns its descendant namespace', async () => {
  await withProject('subrouter-namespace', async (project) => {
    await project.write(
      'src/routes/admin.ts',
      [
        'import { Hono } from "hono";',
        'export default new Hono().get("/", (c) => c.json({ admin: true }));',
        '',
      ].join('\n')
    );
    await project.write('src/routes/admin/stats.ts', GET_ROUTE);

    await expect(project.generate()).rejects.toThrow(
      /namespace conflict[\s\S]*\/admin[\s\S]*owns its complete mount namespace/
    );
  });
});

test('a catch-all segment must be final', async () => {
  await withProject('catch-all-order', async (project) => {
    await project.write('src/routes/$...path/tail.ts', GET_ROUTE);

    await expect(project.generate()).rejects.toThrow(
      /catch-all segment "\$\.\.\.path" must be final/
    );
  });
});

test('an invalid dynamic parameter name fails with its file and parameter', async () => {
  await withProject('bad-parameter', async (project) => {
    await project.write('src/routes/users/$1st.ts', GET_ROUTE);

    await expect(project.generate()).rejects.toThrow(
      /invalid dynamic parameter name "1st"/
    );
  });
});

test('duplicate dynamic parameters in one route fail before generation', async () => {
  await withProject('duplicate-parameter', async (project) => {
    await project.write('src/routes/$id/items/$id.ts', GET_ROUTE);

    await expect(project.generate()).rejects.toThrow(
      /duplicate dynamic parameter "id"/
    );
  });
});

test('a route cannot mix a default sub-router with named method exports', async () => {
  await withProject('mixed-exports', async (project) => {
    await project.write(
      'src/routes/mixed.ts',
      [
        'import { Hono } from "hono";',
        `import { defineHandler } from ${JSON.stringify(APP_MODULE)};`,
        'export const GET = defineHandler((c) => c.json({ ok: true }));',
        'export default new Hono();',
        '',
      ].join('\n')
    );

    await expect(project.generate()).rejects.toThrow(
      /cannot mix a default sub-router export with named method exports \(GET\)/
    );
  });
});

test('a default export that is not a chained Hono router is rejected', async () => {
  await withProject('bad-default', async (project) => {
    await project.write(
      'src/routes/oops.ts',
      'export default { get: () => undefined };\n'
    );

    await expect(project.generate()).rejects.toThrow(
      /the default export must be a chained Hono sub-router/
    );
  });
});

test('a sub-router whose routes are not chained is rejected', async () => {
  await withProject('unchained', async (project) => {
    await project.write(
      'src/routes/admin.ts',
      [
        'import { Hono } from "hono";',
        'const admin = new Hono();',
        'admin.get("/", (c) => c.json({ admin: true }));',
        'export default admin;',
        '',
      ].join('\n')
    );

    await expect(project.generate()).rejects.toThrow(
      /must be chained and assigned so Hono retains their RPC schema/
    );
  });
});

test('a method export that is not a defineHandler tuple is rejected', async () => {
  await withProject('bad-method', async (project) => {
    await project.write(
      'src/routes/bad.ts',
      'export const GET = (c: any) => c.json({ ok: true });\n'
    );

    await expect(project.generate()).rejects.toThrow(
      /GET must use defineHandler\(\) to export a handler tuple/
    );
  });
});

test('a method re-exported from another module is rejected rather than guessed at', async () => {
  await withProject('reexport', async (project) => {
    await project.write('src/routes/shared.ts', GET_ROUTE);
    await project.write(
      'src/routes/reexported.ts',
      'export { GET } from "./shared.ts";\n'
    );

    await expect(project.generate()).rejects.toThrow(
      /GET must use defineHandler\(\)/
    );
  });
});

test('a named method exported through an export list is discovered', async () => {
  await withProject('export-list', async (project) => {
    await project.write(
      'src/routes/listed.ts',
      [
        `import { defineHandler } from ${JSON.stringify(APP_MODULE)};`,
        'const handler = defineHandler((c) => c.json({ ok: true }));',
        'export { handler as GET };',
        '',
      ].join('\n')
    );
    await project.generate();

    expect((await project.manifest()).routes).toContainEqual({
      file: 'src/routes/listed.ts',
      kind: 'methods',
      methods: ['GET'],
      middleware: [],
      path: '/listed',
    });
  });
});

test('directory middleware must export a non-empty tuple', async () => {
  await withProject('empty-middleware', async (project) => {
    await project.write('src/routes/index.ts', GET_ROUTE);
    await project.write(
      'src/routes/_middleware.ts',
      `import { defineMiddleware } from ${JSON.stringify(APP_MODULE)};\nexport default defineMiddleware();\n`
    );

    await expect(project.generate()).rejects.toThrow(
      /Invalid directory middleware[\s\S]*at least one middleware/
    );
  });
});

test('a route file with no method export is ignored with a warning', async () => {
  await withProject('no-methods', async (project) => {
    await project.write('src/routes/health.ts', GET_ROUTE);
    await project.write('src/routes/notes.ts', 'export const notes = [];\n');
    await project.generate();

    expect((await project.manifest()).routes).toHaveLength(1);
    expect(project.warnings.join('\n')).toMatch(
      /Ignoring[\s\S]*notes\.ts[\s\S]*no supported method export/
    );
  });
});

test('reserved basenames and directories are excluded from discovery', async () => {
  await withProject('reserved', async (project) => {
    await project.write('src/routes/health.ts', GET_ROUTE);
    await project.write('src/routes/health.test.ts', GET_ROUTE);
    await project.write('src/routes/health.spec.ts', GET_ROUTE);
    await project.write('src/routes/_private.ts', GET_ROUTE);
    await project.write('src/routes/.hidden.ts', GET_ROUTE);
    await project.write('src/routes/types.d.ts', 'export type X = 1;\n');
    await project.write('src/routes/readme.md', '# not a route\n');
    await project.write('src/routes/__tests__/health.ts', GET_ROUTE);
    await project.write('src/routes/__fixtures__/health.ts', GET_ROUTE);
    await project.write('src/routes/.cache/health.ts', GET_ROUTE);
    await project.generate();

    expect(
      (await project.manifest()).routes.map((entry) => entry.path)
    ).toEqual(['/health']);
  });
});

test('a leading dash colocates a file or directory beside the routes', async () => {
  await withProject('colocation', async (project) => {
    await project.write('src/routes/posts.ts', GET_ROUTE);
    await project.write('src/routes/-post-schema.ts', GET_ROUTE);
    await project.write('src/routes/-queries/list-posts.ts', GET_ROUTE);
    await project.write('src/routes/-queries/nested/insert-post.ts', GET_ROUTE);
    // Excluded by its directory, not by its own name — a colocated subtree
    // contributes no middleware to the routes above it either.
    await project.write('src/routes/-queries/_middleware.ts', middleware());
    await project.generate();

    expect((await project.manifest()).routes).toEqual([
      {
        file: 'src/routes/posts.ts',
        kind: 'methods',
        methods: ['GET'],
        middleware: [],
        path: '/posts',
      },
    ]);
  });
});

test('an escaped dash serves a URL segment that starts with one', async () => {
  await withProject('escaped-dash', async (project) => {
    await project.write('src/routes/[-]well-known.ts', GET_ROUTE);
    await project.write('src/routes/[-assets]/logo.ts', GET_ROUTE);
    await project.generate();

    expect(
      (await project.manifest()).routes.map((entry) => entry.path)
    ).toEqual(['/-well-known', '/-assets/logo']);
  });
});

test('ignoredRouteFiles excludes route-relative globs', async () => {
  await withProject('ignored-globs', async (project) => {
    await project.write('src/routes/health.ts', GET_ROUTE);
    await project.write('src/routes/internal/debug.ts', GET_ROUTE);
    await project.generate({ ignoredRouteFiles: ['internal/**'] });

    expect(
      (await project.manifest()).routes.map((entry) => entry.path)
    ).toEqual(['/health']);
  });
});

test('a group directory contributes middleware without a URL segment', async () => {
  await withProject('groups', async (project) => {
    await project.write('src/routes/(authed)/_middleware.ts', middleware());
    await project.write('src/routes/(authed)/orders.ts', GET_ROUTE);
    await project.generate();

    expect((await project.manifest()).routes).toContainEqual({
      file: 'src/routes/(authed)/orders.ts',
      kind: 'methods',
      methods: ['GET'],
      middleware: ['src/routes/(authed)/_middleware.ts'],
      path: '/orders',
    });
  });
});

test('two routes collapsing onto one URL through a group explain the collapse', async () => {
  await withProject('group-collapse', async (project) => {
    await project.write('src/routes/(authed)/orders.ts', GET_ROUTE);
    await project.write('src/routes/orders.ts', GET_ROUTE);

    await expect(project.generate()).rejects.toThrow(
      /Route conflict at "\/orders"[\s\S]*"\(group\)" directory contributes middleware only/
    );
  });
});

test('every conflict is reported, not just the first one found', async () => {
  await withProject('all-conflicts', async (project) => {
    await project.write('src/routes/api/users.ts', GET_ROUTE);
    await project.write('src/routes/api/users/index.ts', GET_ROUTE);
    await project.write('src/routes/api/posts.ts', GET_ROUTE);
    await project.write('src/routes/api/posts/index.ts', GET_ROUTE);

    // Conflicts arrive in batches — the rename that collided `users` usually
    // collided `posts` too — so fixing them one run at a time is the slow way
    // to find the second one.
    const error = await project.generate().catch((cause: unknown) => cause);
    const message = error instanceof Error ? error.message : String(error);

    expect(message).toContain('Route conflict at "/api/users"');
    expect(message).toContain('Route conflict at "/api/posts"');
  });
});

test('three files on one URL are one conflict listing three files', async () => {
  await withProject('triple-conflict', async (project) => {
    await project.write('src/routes/health.ts', GET_ROUTE);
    await project.write('src/routes/health/index.ts', GET_ROUTE);
    await project.write('src/routes/(authed)/health.ts', GET_ROUTE);

    const error = await project.generate().catch((cause: unknown) => cause);
    const message = error instanceof Error ? error.message : String(error);

    // Pairwise scanning finds three pairs here. The report is keyed by the
    // conflicting path, so it stays one block with three files under it.
    expect(message.match(/Route conflict at "\/health"/g)).toHaveLength(1);
    expect(message).toContain('- src/routes/health.ts');
    expect(message).toContain('- src/routes/health/index.ts');
    expect(message).toContain('- src/routes/(authed)/health.ts');
  });
});

test('a group must be a directory, and says so when a file names one', async () => {
  await withProject('group-file', async (project) => {
    await project.write('src/routes/(authed).ts', GET_ROUTE);

    await expect(project.generate()).rejects.toThrow(
      /names a route group, which only a directory can be/
    );
  });
});

test('an unnamed group and a dynamic group are both rejected', async () => {
  await withProject('group-names', async (project) => {
    await project.write('src/routes/()/orders.ts', GET_ROUTE);

    await expect(project.generate()).rejects.toThrow(/needs a name/);
  });

  await withProject('group-dynamic', async (project) => {
    await project.write('src/routes/($tenant)/orders.ts', GET_ROUTE);

    await expect(project.generate()).rejects.toThrow(
      /cannot declare a dynamic parameter/
    );
  });
});

test('an escaped segment reaches the URL literally', async () => {
  await withProject('escapes', async (project) => {
    await project.write('src/routes/[(not-a-group)].ts', GET_ROUTE);
    await project.write('src/routes/[$literal].ts', GET_ROUTE);
    await project.generate();

    expect(
      (await project.manifest()).routes.map((entry) => entry.path)
    ).toEqual(expect.arrayContaining(['/(not-a-group)', '/$literal']));
  });
});

test('a static segment cannot smuggle in Hono path syntax', async () => {
  await withProject('hono-syntax', async (project) => {
    await project.write('src/routes/[:]id.ts', GET_ROUTE);

    await expect(project.generate()).rejects.toThrow(
      /contains ":", which is Hono path syntax/
    );
  });
});

test('a validator schema that disagrees with the filename warns', async () => {
  await withProject('schema-mismatch', async (project) => {
    await project.write(
      'src/routes/users/$id.ts',
      [
        'import { zValidator } from "@hono/zod-validator";',
        'import { z } from "zod";',
        `import { defineHandler } from ${JSON.stringify(APP_MODULE)};`,
        'export const GET = defineHandler(',
        '  zValidator("param", z.object({ userId: z.string() })),',
        '  (c) => c.json({ ok: true })',
        ');',
        '',
      ].join('\n')
    );
    await project.generate();

    expect(project.warnings.join('\n')).toMatch(
      /parameter schema declaring \[userId\][\s\S]*filename path \/users\/:id declares \[id\]/
    );
  });
});

test('an app module that never mounts the router warns with the route count', async () => {
  await withProject(
    'no-mount',
    async (project) => {
      await project.write('src/routes/health.ts', GET_ROUTE);
      await project.generate();

      expect(project.warnings.join('\n')).toMatch(
        /never mounts #shinro\/routes, so 1 file route is not served/
      );
    },
    {
      app: `import { defineApp } from ${JSON.stringify(APP_MODULE)};\nexport default defineApp();\n`,
    }
  );
});

test('an app with no file routes is not asked to mount anything', async () => {
  await withProject(
    'no-routes',
    async (project) => {
      await project.generate();

      expect(project.warnings.join('\n')).not.toMatch(/never mounts/);
    },
    {
      app: `import { defineApp } from ${JSON.stringify(APP_MODULE)};\nexport default defineApp();\n`,
    }
  );
});

test('middleware registered after the mount warns about registration order', async () => {
  await withProject(
    'mount-order',
    async (project) => {
      await project.write('src/routes/health.ts', GET_ROUTE);
      await project.generate();

      expect(project.warnings.join('\n')).toMatch(
        /registers middleware after \.route\("\/", routes\(\)\)/
      );
    },
    {
      app: [
        `import { defineApp } from ${JSON.stringify(APP_MODULE)};`,
        'import { routes } from "#shinro/routes";',
        'export default defineApp()',
        '  .route("/", routes())',
        '  .use("*", async (_c, next) => { await next(); });',
        '',
      ].join('\n'),
    }
  );
});

test('an app module must default-export a Hono instance', async () => {
  await withProject(
    'bad-app',
    async (project) => {
      await expect(project.generate()).rejects.toThrow(
        /default-export a Hono instance/
      );
    },
    { app: 'export default { fetch: () => new Response("no") };\n' }
  );
});

test('a missing app module names the option that points at it', async () => {
  await withProject('missing-app', async (project) => {
    await project.remove('src/app.ts');

    await expect(project.generate()).rejects.toThrow(
      /App module not found[\s\S]*shinro\.config\.json/
    );
  });
});

test('a missing routes directory names the option that points at it', async () => {
  await withProject('missing-routes', async (project) => {
    await expect(project.generate({ routes: 'src/pages' })).rejects.toThrow(
      /Routes directory not found[\s\S]*shinro\.config\.json/
    );
  });
});

test('a relative import of the generated router is never warned about', async () => {
  await withProject(
    'relative-import',
    async (project) => {
      await project.write('src/routes/health.ts', GET_ROUTE);
      await project.generate();

      expect(project.warnings.join('\n')).not.toMatch(/never mounts/);
      expect(project.warnings.join('\n')).not.toMatch(/imports/);
    },
    {
      app: [
        `import { defineApp } from ${JSON.stringify(APP_MODULE)};`,
        'import { routes } from "../.shinro/routes.ts";',
        'export default defineApp().route("/", routes());',
        '',
      ].join('\n'),
      packageJson: { name: 'no-imports-block', type: 'module' },
    }
  );
});

test('an imports block pointing somewhere other than .shinro is corrected', async () => {
  await withProject(
    'wrong-imports',
    async (project) => {
      await project.write('src/routes/health.ts', GET_ROUTE);
      await project.generate();

      expect(project.warnings.join('\n')).toMatch(
        /declares "#shinro\/routes" pointing somewhere other than "\.\/\.shinro\/routes\.ts"/
      );
    },
    {
      packageJson: {
        name: 'wrong-imports',
        type: 'module',
        imports: { '#shinro/routes': './generated/routes.ts' },
      },
    }
  );
});
