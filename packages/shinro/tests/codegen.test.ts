import { expect, test } from 'vite-plus/test';

import { GENERATED_FORMAT, HONO_HANDLER_LIMIT } from '../src/constants.ts';
import { APP_MODULE, GET_ROUTE, middleware, withProject } from './helpers.ts';

test('the generated router imports route modules by relative path with .ts intact', async () => {
  await withProject('specifiers', async (project) => {
    await project.write('src/routes/health.ts', GET_ROUTE);
    await project.generate();

    const routes = await project.generated('routes.ts');
    // A real file on disk, which every runner resolves without a plugin, an
    // alias, or a compiler option.
    expect(routes).toContain('from "../src/routes/health.ts"');
    expect(routes).not.toContain('shinro/routes');
  });
});

test('the generated router stays runtime-neutral', async () => {
  await withProject('neutral', async (project) => {
    await project.write('src/routes/_middleware.ts', middleware());
    await project.write('src/routes/health.ts', GET_ROUTE);
    await project.generate();

    const routes = await project.generated('routes.ts');
    // No `node:` specifier reaches the router, so the same output runs on a
    // Worker, on Deno, and on Node.
    expect(routes).not.toMatch(/from "node:/);
    expect(
      [...routes.matchAll(/from "([^".][^"]*)"/g)].map((m) => m[1])
    ).toEqual(['hono', 'shinro/app']);
  });
});

test('directory middleware is inlined, one slot each, by default', async () => {
  await withProject('inline-middleware', async (project) => {
    await project.write('src/routes/_middleware.ts', middleware(2));
    await project.write('src/routes/deep/_middleware.ts', middleware(1));
    await project.write('src/routes/deep/thing.ts', GET_ROUTE);
    await project.generate();

    const routes = await project.generated('routes.ts');
    // Inlining is the higher-fidelity emit: a `defineMiddleware` element keeps its
    // own return type, so a middleware that short-circuits with a 401 puts that
    // 401 in the route's client contract. `every()` would erase it.
    expect(routes).not.toContain('hono/combine');
    expect(routes).toMatch(
      /\.get\("\/deep\/thing", \.\.\.middleware\d, \.\.\.middleware\d, \.\.\.route\d+GET\)/
    );
  });
});

test('a route that would overflow the typed limit composes instead, and says so', async () => {
  await withProject('composition', async (project) => {
    await project.write('src/routes/_middleware.ts', middleware(1));
    await project.write('src/routes/deep/_middleware.ts', middleware(2));
    await project.write('src/routes/index.ts', GET_ROUTE);
    await project.write(
      'src/routes/deep/wide.ts',
      [
        `import { defineHandler } from ${JSON.stringify(APP_MODULE)};`,
        'const pass = async (_c: any, next: any) => { await next(); };',
        'export const GET = defineHandler(',
        ...Array.from({ length: HONO_HANDLER_LIMIT - 3 }, () => '  pass,'),
        '  (c) => c.json({ ok: true })',
        ');',
        '',
      ].join('\n')
    );
    await project.generate();

    const routes = await project.generated('routes.ts');
    // Eight tuple elements plus three middleware is eleven inlined, one over the
    // cliff. Composing the middleware into one slot brings it to nine and keeps
    // the validator contract — the trade is stated rather than made silently.
    expect(routes).toContain('import { every } from "hono/combine";');
    expect(routes).toMatch(
      /\.get\("\/deep\/wide", every\(\.\.\.middleware\d, \.\.\.middleware\d\), \.\.\.route\d+GET\)/
    );
    expect(project.warnings.join('\n')).toMatch(
      /reaches 11 handlers once its directory middleware are inlined[\s\S]*composed into one slot with every\(\)[\s\S]*early response from those middleware is no longer part/
    );
    // Only the route that needed it: the sibling keeps its middleware inlined.
    expect(routes).toMatch(
      /\.get\("\/", \.\.\.middleware\d, \.\.\.route\d+GET\)/
    );
  });
});

test('one middleware file is imported once however many routes use it', async () => {
  await withProject('shared-middleware', async (project) => {
    await project.write('src/routes/_middleware.ts', middleware());
    await project.write('src/routes/a.ts', GET_ROUTE);
    await project.write('src/routes/b.ts', GET_ROUTE);
    await project.write('src/routes/c.ts', GET_ROUTE);
    await project.generate();

    const routes = await project.generated('routes.ts');
    expect([
      ...routes.matchAll(/from "\.\.\/src\/routes\/_middleware\.ts"/g),
    ]).toHaveLength(1);
  });
});

test("a route whose emitted registration would exceed Hono's typed limit fails", async () => {
  await withProject('arity', async (project) => {
    await project.write('src/routes/_middleware.ts', middleware(2));
    await project.write(
      'src/routes/wide.ts',
      [
        `import { defineHandler } from ${JSON.stringify(APP_MODULE)};`,
        'const pass = async (_c: any, next: any) => { await next(); };',
        'export const GET = defineHandler(',
        ...Array.from({ length: HONO_HANDLER_LIMIT - 1 }, () => '  pass,'),
        '  (c) => c.json({ ok: true })',
        ');',
        '',
      ].join('\n')
    );

    // Past path + ten, Hono's typed overloads give way to a variadic fallback
    // that infers one shared input for the whole chain, so the generated client
    // silently loses every validator's contract. Generate is the only step that
    // knows the emitted arity, so it is the only step that can refuse.
    await expect(project.generate()).rejects.toThrow(
      /Too many handlers[\s\S]*GET \/wide \(11 handlers\)[\s\S]*wide\.ts: 10 in the defineHandler tuple[\s\S]*1 slot once composed/
    );
  });
});

test('a maximal registration one slot under the limit is emitted', async () => {
  await withProject('arity-limit', async (project) => {
    await project.write('src/routes/_middleware.ts', middleware(3));
    await project.write(
      'src/routes/wide.ts',
      [
        `import { defineHandler } from ${JSON.stringify(APP_MODULE)};`,
        'const pass = async (_c: any, next: any) => { await next(); };',
        'export const GET = defineHandler(',
        ...Array.from({ length: HONO_HANDLER_LIMIT - 2 }, () => '  pass,'),
        '  (c) => c.json({ ok: true })',
        ');',
        '',
      ].join('\n')
    );
    await project.generate();

    expect(await project.generated('routes.ts')).toContain('/wide');
  });
});

test('a handler tuple of unknown length is left to TypeScript', async () => {
  await withProject('arity-unknown', async (project) => {
    await project.write('src/routes/_middleware.ts', middleware(2));
    await project.write(
      'src/routes/spread.ts',
      [
        `import { defineHandler } from ${JSON.stringify(APP_MODULE)};`,
        'const shared = [] as any[];',
        'export const GET = defineHandler(...shared, (c: any) => c.json({ ok: true }));',
        '',
      ].join('\n')
    );

    // A spread makes the arity unknowable, and guessing at a limit would reject
    // working code. TypeScript checks the spread exactly, against the user's own
    // source rather than against generated output.
    await expect(project.generate()).resolves.toBeTruthy();
  });
});

test('a sub-router with directory middleware is wrapped once before the chain', async () => {
  await withProject('subrouter-middleware', async (project) => {
    await project.write('src/routes/_middleware.ts', middleware());
    await project.write(
      'src/routes/admin.ts',
      [
        'import { Hono } from "hono";',
        'export default new Hono().get("/", (c) => c.json({ admin: true }));',
        '',
      ].join('\n')
    );
    await project.generate();

    const routes = await project.generated('routes.ts');
    expect(routes).toMatch(/const route\d+Mounted = new Hono<ProjectEnv>\(\)/);
    expect(routes).toMatch(/\.use\("\*", \.\.\.middleware\d\)/);
    expect(project.warnings.join('\n')).toMatch(
      /default sub-router surrounded by directory middleware/
    );
  });
});

test('the client is the only generated module that reaches for the app', async () => {
  await withProject('client', async (project) => {
    await project.write('src/routes/health.ts', GET_ROUTE);
    await project.generate();

    const client = await project.generated('client.ts');
    expect(client).toContain('import type app from "../src/app.ts";');
    expect(client).toContain('type AppType = typeof app;');
    expect(await project.generated('routes.ts')).not.toContain('src/app.ts');
  });
});

test('a route receives an optional type declaration carrying its path and params', async () => {
  await withProject('declarations', async (project) => {
    await project.write(
      'src/routes/teams/$teamId/members/$memberId.ts',
      GET_ROUTE
    );
    await project.generate();

    const declaration = await project.generated(
      'types/src/routes/teams/$teamId/members/+types/teams/$teamId/members/$memberId.d.ts'
    );
    expect(declaration).toContain('path: "/teams/:teamId/members/:memberId";');
    expect(declaration).toContain(
      'params: { "teamId": string; "memberId": string };'
    );
  });
});

test('directory middleware receives a declaration for the path it wraps', async () => {
  await withProject('middleware-declaration', async (project) => {
    await project.write(
      'src/routes/teams/$teamId/_middleware.ts',
      middleware()
    );
    await project.write('src/routes/teams/$teamId/index.ts', GET_ROUTE);
    await project.generate();

    expect(
      await project.generated(
        'types/src/routes/teams/$teamId/+types/teams/$teamId/_middleware.d.ts'
      )
    ).toContain('path: "/teams/:teamId";');
  });
});

test('a route with no parameters declares that it has none', async () => {
  await withProject('no-params', async (project) => {
    await project.write('src/routes/health.ts', GET_ROUTE);
    await project.generate();

    expect(
      await project.generated('types/src/routes/+types/health.d.ts')
    ).toContain('params: Record<never, never>;');
  });
});

test('the manifest records project-relative paths and the format that wrote them', async () => {
  await withProject('manifest', async (project) => {
    await project.write('src/routes/_middleware.ts', middleware());
    await project.write('src/routes/health.ts', GET_ROUTE);
    await project.write(
      'src/routes/admin.ts',
      [
        'import { Hono } from "hono";',
        'export default new Hono().get("/", (c) => c.json({ admin: true }));',
        '',
      ].join('\n')
    );
    await project.generate();

    const manifest = await project.manifest();
    expect(manifest.format).toBe(GENERATED_FORMAT);
    expect(manifest.routes).toContainEqual({
      file: 'src/routes/health.ts',
      kind: 'methods',
      methods: ['GET'],
      middleware: ['src/routes/_middleware.ts'],
      path: '/health',
    });
    expect(manifest.routes).toContainEqual({
      file: 'src/routes/admin.ts',
      kind: 'sub-router',
      middleware: ['src/routes/_middleware.ts'],
      mountPath: '/admin',
    });
  });
});

test('every generated file identifies its format and warns against editing', async () => {
  await withProject('notice', async (project) => {
    await project.write('src/routes/health.ts', GET_ROUTE);
    await project.generate();

    const notice = `Generated by Shinro (format ${GENERATED_FORMAT}). Do not edit.`;
    expect(await project.generated('routes.ts')).toContain(`// ${notice}`);
    expect(await project.generated('client.ts')).toContain(`// ${notice}`);
    expect(
      await project.generated('types/src/routes/+types/health.d.ts')
    ).toContain(`// ${notice}`);
    expect(await project.generated('manifest.json')).toContain(notice);
  });
});

test('base-app middleware with an early response is reported as missing from contracts', async () => {
  await withProject(
    'early-response',
    async (project) => {
      await project.write('src/routes/health.ts', GET_ROUTE);
      await project.generate();

      expect(project.warnings.join('\n')).toMatch(
        /base-app middleware with an early response/
      );
    },
    {
      app: [
        `import { defineApp } from ${JSON.stringify(APP_MODULE)};`,
        'import { routes } from "#shinro/routes";',
        'const app = defineApp();',
        'app.use("*", async (c, next) => {',
        '  if (!c.req.header("authorization")) { return c.json({ error: "UNAUTHORIZED" }, 401); }',
        '  await next();',
        '});',
        'export default app.route("/", routes());',
        '',
      ].join('\n'),
    }
  );
});
