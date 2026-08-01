import { expect, test } from 'vite-plus/test';

import { APP_MODULE, GET_ROUTE, middleware, withProject } from './helpers.ts';

const SUB_ROUTER = [
  'import { Hono } from "hono";',
  'export default new Hono().get("/", (c) => c.json({ admin: true }));',
  '',
].join('\n');

test('a filename derives the URL it serves', async () => {
  await withProject('urls', async (project) => {
    await project.write('src/routes/index.ts', GET_ROUTE);
    await project.write('src/routes/health.ts', GET_ROUTE);
    await project.write('src/routes/users/index.ts', GET_ROUTE);
    await project.write('src/routes/users/$id.ts', GET_ROUTE);
    await project.write('src/routes/files/latest.ts', GET_ROUTE);
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
      '/files/latest',
      '/users/:id',
      '/files/:path{.+}',
    ]);
  });
});

test('an escaped segment reaches the URL literally', async () => {
  await withProject('escapes', async (project) => {
    await project.write('src/routes/[(not-a-group)].ts', GET_ROUTE);
    await project.write('src/routes/[$literal].ts', GET_ROUTE);
    await project.write('src/routes/[-]well-known.ts', GET_ROUTE);
    await project.write('src/routes/[-assets]/logo.ts', GET_ROUTE);
    await project.generate();

    expect(
      (await project.manifest()).routes.map((entry) => entry.path)
    ).toEqual(
      expect.arrayContaining([
        '/(not-a-group)',
        '/$literal',
        '/-well-known',
        '/-assets/logo',
      ])
    );
  });
});

test('excluded files and directories never become routes', async () => {
  await withProject('excluded', async (project) => {
    await project.write('src/routes/health.ts', GET_ROUTE);
    await project.write('src/routes/posts.ts', GET_ROUTE);
    await project.write('src/routes/health.test.ts', GET_ROUTE);
    await project.write('src/routes/health.spec.ts', GET_ROUTE);
    await project.write('src/routes/_private.ts', GET_ROUTE);
    await project.write('src/routes/.hidden.ts', GET_ROUTE);
    await project.write('src/routes/types.d.ts', 'export type X = 1;\n');
    await project.write('src/routes/readme.md', '# not a route\n');
    await project.write('src/routes/__tests__/health.ts', GET_ROUTE);
    await project.write('src/routes/__fixtures__/health.ts', GET_ROUTE);
    await project.write('src/routes/.cache/health.ts', GET_ROUTE);
    await project.write('src/routes/-post-schema.ts', GET_ROUTE);
    await project.write('src/routes/-queries/list-posts.ts', GET_ROUTE);
    await project.write('src/routes/-queries/nested/insert-post.ts', GET_ROUTE);
    await project.write('src/routes/-queries/_middleware.ts', middleware());
    await project.write('src/routes/internal/debug.ts', GET_ROUTE);
    await project.generate({ ignoredRouteFiles: ['internal/**'] });

    expect((await project.manifest()).routes).toEqual([
      {
        file: 'src/routes/health.ts',
        kind: 'methods',
        methods: ['GET'],
        middleware: [],
        path: '/health',
      },
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

test('an export list and a group directory both reach the manifest', async () => {
  await withProject('discovery', async (project) => {
    await project.write(
      'src/routes/listed.ts',
      [
        `import { defineHandler } from ${JSON.stringify(APP_MODULE)};`,
        'const handler = defineHandler((c) => c.json({ ok: true }));',
        'export { handler as GET };',
        '',
      ].join('\n')
    );
    await project.write('src/routes/(authed)/_middleware.ts', middleware());
    await project.write('src/routes/(authed)/orders.ts', GET_ROUTE);
    await project.generate();

    const { routes } = await project.manifest();
    expect(routes).toContainEqual({
      file: 'src/routes/listed.ts',
      kind: 'methods',
      methods: ['GET'],
      middleware: [],
      path: '/listed',
    });
    expect(routes).toContainEqual({
      file: 'src/routes/(authed)/orders.ts',
      kind: 'methods',
      methods: ['GET'],
      middleware: ['src/routes/(authed)/_middleware.ts'],
      path: '/orders',
    });
  });
});

test('an invalid filename fails with its file and the reason', async () => {
  const cases: [files: Record<string, string>, message: RegExp][] = [
    [
      { 'src/routes/$...path/tail.ts': GET_ROUTE },
      /catch-all segment "\$\.\.\.path" must be final/,
    ],
    [
      { 'src/routes/users/$1st.ts': GET_ROUTE },
      /invalid dynamic parameter name "1st"/,
    ],
    [
      { 'src/routes/$id/items/$id.ts': GET_ROUTE },
      /duplicate dynamic parameter "id"/,
    ],
    [
      { 'src/routes/[:]id.ts': GET_ROUTE },
      /contains ":", which is Hono path syntax/,
    ],
    [
      { 'src/routes/(authed).ts': GET_ROUTE },
      /names a route group, which only a directory can be/,
    ],
    [{ 'src/routes/()/orders.ts': GET_ROUTE }, /needs a name/],
    [
      { 'src/routes/($tenant)/orders.ts': GET_ROUTE },
      /cannot declare a dynamic parameter/,
    ],
  ];

  for (const [files, message] of cases) {
    await withProject('bad-filename', async (project) => {
      for (const [path, contents] of Object.entries(files)) {
        await project.write(path, contents);
      }

      await expect(project.generate()).rejects.toThrow(message);
    });
  }
});

test('an invalid route export is rejected rather than guessed at', async () => {
  const cases: [files: Record<string, string>, message: RegExp][] = [
    [
      {
        'src/routes/mixed.ts': [
          'import { Hono } from "hono";',
          `import { defineHandler } from ${JSON.stringify(APP_MODULE)};`,
          'export const GET = defineHandler((c) => c.json({ ok: true }));',
          'export default new Hono();',
          '',
        ].join('\n'),
      },
      /cannot mix a default sub-router export with named method exports \(GET\)/,
    ],
    [
      { 'src/routes/oops.ts': 'export default { get: () => undefined };\n' },
      /the default export must be a chained Hono sub-router/,
    ],
    [
      {
        'src/routes/admin.ts': [
          'import { Hono } from "hono";',
          'const admin = new Hono();',
          'admin.get("/", (c) => c.json({ admin: true }));',
          'export default admin;',
          '',
        ].join('\n'),
      },
      /must be chained and assigned so Hono retains their RPC schema/,
    ],
    [
      {
        'src/routes/bad.ts':
          'export const GET = (c: any) => c.json({ ok: true });\n',
      },
      /GET must use defineHandler\(\) to export a handler tuple/,
    ],
    [
      {
        'src/routes/shared.ts': GET_ROUTE,
        'src/routes/reexported.ts': 'export { GET } from "./shared.ts";\n',
      },
      /GET must use defineHandler\(\)/,
    ],
    [
      {
        'src/routes/index.ts': GET_ROUTE,
        'src/routes/_middleware.ts': `import { defineMiddleware } from ${JSON.stringify(APP_MODULE)};\nexport default defineMiddleware();\n`,
      },
      /Invalid directory middleware[\s\S]*at least one middleware/,
    ],
  ];

  for (const [files, message] of cases) {
    await withProject('bad-export', async (project) => {
      for (const [path, contents] of Object.entries(files)) {
        await project.write(path, contents);
      }

      await expect(project.generate()).rejects.toThrow(message);
    });
  }
});

test('a route conflict names every colliding file', async () => {
  await withProject('conflict', async (project) => {
    await project.write('src/routes/users.ts', GET_ROUTE);
    await project.write('src/routes/users/index.ts', GET_ROUTE);

    await expect(project.generate()).rejects.toThrow(
      /\[shinro\][\s\S]*\/users[\s\S]*(?:users\.ts[\s\S]*users\/index\.ts|users\/index\.ts[\s\S]*users\.ts)/
    );
  });

  await withProject('dynamic-shape', async (project) => {
    await project.write('src/routes/users/$id.ts', GET_ROUTE);
    await project.write('src/routes/users/$slug.ts', GET_ROUTE);

    await expect(project.generate()).rejects.toThrow(
      /\/users\/:id[\s\S]*(?:\$id\.ts[\s\S]*\$slug\.ts|\$slug\.ts[\s\S]*\$id\.ts)/
    );
  });

  await withProject('group-collapse', async (project) => {
    await project.write('src/routes/(authed)/orders.ts', GET_ROUTE);
    await project.write('src/routes/orders.ts', GET_ROUTE);

    await expect(project.generate()).rejects.toThrow(
      /Route conflict at "\/orders"[\s\S]*"\(group\)" directory contributes middleware only/
    );
  });

  await withProject('subrouter-namespace', async (project) => {
    await project.write('src/routes/admin.ts', SUB_ROUTER);
    await project.write('src/routes/admin/stats.ts', GET_ROUTE);

    await expect(project.generate()).rejects.toThrow(
      /namespace conflict[\s\S]*\/admin[\s\S]*owns its complete mount namespace/
    );
  });
});

test('every conflict is reported, keyed by the path they collide on', async () => {
  await withProject('all-conflicts', async (project) => {
    await project.write('src/routes/api/users.ts', GET_ROUTE);
    await project.write('src/routes/api/users/index.ts', GET_ROUTE);
    await project.write('src/routes/api/posts.ts', GET_ROUTE);
    await project.write('src/routes/api/posts/index.ts', GET_ROUTE);

    const message = await generateError(project);

    expect(message).toContain('Route conflict at "/api/users"');
    expect(message).toContain('Route conflict at "/api/posts"');
  });

  await withProject('triple-conflict', async (project) => {
    await project.write('src/routes/health.ts', GET_ROUTE);
    await project.write('src/routes/health/index.ts', GET_ROUTE);
    await project.write('src/routes/(authed)/health.ts', GET_ROUTE);

    const message = await generateError(project);

    expect(message.match(/Route conflict at "\/health"/g)).toHaveLength(1);
    expect(message).toContain('- src/routes/health.ts');
    expect(message).toContain('- src/routes/health/index.ts');
    expect(message).toContain('- src/routes/(authed)/health.ts');
  });
});

test('a file that cannot serve a route is warned about, not failed on', async () => {
  await withProject('warnings', async (project) => {
    await project.write('src/routes/health.ts', GET_ROUTE);
    await project.write('src/routes/notes.ts', 'export const notes = [];\n');
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

    expect((await project.manifest()).routes).toHaveLength(2);
    expect(project.warnings.join('\n')).toMatch(
      /Ignoring[\s\S]*notes\.ts[\s\S]*no supported method export/
    );
    expect(project.warnings.join('\n')).toMatch(
      /parameter schema declaring \[userId\][\s\S]*filename path \/users\/:id declares \[id\]/
    );
  });
});

test('an app module that mounts the router late or never is warned', async () => {
  const bareApp = `import { defineApp } from ${JSON.stringify(APP_MODULE)};\nexport default defineApp();\n`;

  await withProject(
    'no-mount',
    async (project) => {
      await project.write('src/routes/health.ts', GET_ROUTE);
      await project.generate();

      expect(project.warnings.join('\n')).toMatch(
        /never mounts #shinro\/routes, so 1 file route is not served/
      );
    },
    { app: bareApp }
  );

  await withProject(
    'no-routes',
    async (project) => {
      await project.generate();

      expect(project.warnings.join('\n')).not.toMatch(/never mounts/);
    },
    { app: bareApp }
  );

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

test('a missing app module or routes directory names the option that points at it', async () => {
  await withProject(
    'bad-app',
    async (project) => {
      await expect(project.generate()).rejects.toThrow(
        /default-export a Hono instance/
      );
    },
    { app: 'export default { fetch: () => new Response("no") };\n' }
  );

  await withProject('missing-app', async (project) => {
    await project.remove('src/app.ts');

    await expect(project.generate()).rejects.toThrow(
      /App module not found[\s\S]*shinro\.config\.json/
    );
  });

  await withProject('missing-routes', async (project) => {
    await expect(project.generate({ routes: 'src/pages' })).rejects.toThrow(
      /Routes directory not found[\s\S]*shinro\.config\.json/
    );
  });
});

test('the imports block is only mentioned when it points somewhere wrong', async () => {
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

async function generateError(project: {
  generate: () => Promise<unknown>;
}): Promise<string> {
  const error = await project.generate().catch((cause: unknown) => cause);
  return error instanceof Error ? error.message : String(error);
}
