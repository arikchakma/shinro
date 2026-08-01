import { expect, test } from 'vite-plus/test';

import { GENERATED_FORMAT, HONO_HANDLER_LIMIT } from '../src/constants.ts';
import { APP_MODULE, GET_ROUTE, middleware, withProject } from './helpers.ts';

const SUB_ROUTER = [
  'import { Hono } from "hono";',
  'export default new Hono().get("/", (c) => c.json({ admin: true }));',
  '',
].join('\n');

function wideRoute(handlers: number): string {
  return [
    `import { defineHandler } from ${JSON.stringify(APP_MODULE)};`,
    'const pass = async (_c: any, next: any) => { await next(); };',
    'export const GET = defineHandler(',
    ...Array.from({ length: handlers }, () => '  pass,'),
    '  (c) => c.json({ ok: true })',
    ');',
    '',
  ].join('\n');
}

test('the generated router imports route modules directly and stays runtime-neutral', async () => {
  await withProject('specifiers', async (project) => {
    await project.write('src/routes/_middleware.ts', middleware());
    await project.write('src/routes/health.ts', GET_ROUTE);
    await project.generate();

    const routes = await project.generated('routes.ts');
    expect(routes).toContain('from "../src/routes/health.ts"');
    expect(routes).not.toContain('shinro/routes');
    expect(routes).not.toMatch(/from "node:/);
    expect(
      [...routes.matchAll(/from "([^".][^"]*)"/g)].map((m) => m[1])
    ).toEqual(['hono', 'shinro/app']);
  });
});

test('directory middleware is inlined, one slot each, and imported once', async () => {
  await withProject('inline-middleware', async (project) => {
    await project.write('src/routes/_middleware.ts', middleware(2));
    await project.write('src/routes/deep/_middleware.ts', middleware(1));
    await project.write('src/routes/deep/thing.ts', GET_ROUTE);
    await project.write('src/routes/a.ts', GET_ROUTE);
    await project.write('src/routes/b.ts', GET_ROUTE);
    await project.generate();

    const routes = await project.generated('routes.ts');
    // Inlining keeps each middleware's own return type, and with it any early
    // response it puts in the route's client contract. `every()` erases that.
    expect(routes).not.toContain('hono/combine');
    expect(routes).toMatch(
      /\.get\("\/deep\/thing", \.\.\.middleware\d, \.\.\.middleware\d, \.\.\.route\d+GET\)/
    );
    expect([
      ...routes.matchAll(/from "\.\.\/src\/routes\/_middleware\.ts"/g),
    ]).toHaveLength(1);
  });
});

test('a route that would overflow the typed limit composes instead, and says so', async () => {
  await withProject('composition', async (project) => {
    await project.write('src/routes/_middleware.ts', middleware(1));
    await project.write('src/routes/deep/_middleware.ts', middleware(2));
    await project.write('src/routes/index.ts', GET_ROUTE);
    await project.write(
      'src/routes/deep/wide.ts',
      wideRoute(HONO_HANDLER_LIMIT - 3)
    );
    await project.generate();

    const routes = await project.generated('routes.ts');
    expect(routes).toContain('import { every } from "hono/combine";');
    expect(routes).toMatch(
      /\.get\("\/deep\/wide", every\(\.\.\.middleware\d, \.\.\.middleware\d\), \.\.\.route\d+GET\)/
    );
    expect(project.warnings.join('\n')).toMatch(
      /reaches 11 handlers once its directory middleware are inlined[\s\S]*composed into one slot with every\(\)[\s\S]*early response from those middleware is no longer part/
    );
    expect(routes).toMatch(
      /\.get\("\/", \.\.\.middleware\d, \.\.\.route\d+GET\)/
    );
  });
});

test("emitted arity is checked against Hono's typed limit", async () => {
  // Past the limit Hono falls back to a variadic overload that infers one shared
  // input for the whole chain, silently losing every validator's contract.
  await withProject('arity', async (project) => {
    await project.write('src/routes/_middleware.ts', middleware(2));
    await project.write(
      'src/routes/wide.ts',
      wideRoute(HONO_HANDLER_LIMIT - 1)
    );

    await expect(project.generate()).rejects.toThrow(
      /Too many handlers[\s\S]*GET \/wide \(11 handlers\)[\s\S]*wide\.ts: 10 in the defineHandler tuple[\s\S]*1 slot once composed/
    );
  });

  await withProject('arity-limit', async (project) => {
    await project.write('src/routes/_middleware.ts', middleware(3));
    await project.write(
      'src/routes/wide.ts',
      wideRoute(HONO_HANDLER_LIMIT - 2)
    );
    await project.generate();

    expect(await project.generated('routes.ts')).toContain('/wide');
  });

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

    await expect(project.generate()).resolves.toBeTruthy();
  });
});

test('a sub-router with directory middleware is wrapped once before the chain', async () => {
  await withProject('subrouter-middleware', async (project) => {
    await project.write('src/routes/_middleware.ts', middleware());
    await project.write('src/routes/admin.ts', SUB_ROUTER);
    await project.generate();

    const routes = await project.generated('routes.ts');
    expect(routes).toMatch(/const route\d+Mounted = new Hono<ProjectEnv>\(\)/);
    expect(routes).toMatch(/\.use\("\*", \.\.\.middleware\d\)/);
    expect(project.warnings.join('\n')).toMatch(
      /mounts a sub-router: its directory middleware run/
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

test('a type declaration carries the path and params of what it describes', async () => {
  await withProject('declarations', async (project) => {
    await project.write('src/routes/health.ts', GET_ROUTE);
    await project.write(
      'src/routes/teams/$teamId/members/$memberId.ts',
      GET_ROUTE
    );
    await project.write(
      'src/routes/teams/$teamId/_middleware.ts',
      middleware()
    );
    await project.write('src/routes/teams/$teamId/index.ts', GET_ROUTE);
    await project.generate();

    const route = await project.generated(
      'types/src/routes/teams/$teamId/members/+types/teams/$teamId/members/$memberId.d.ts'
    );
    expect(route).toContain('path: "/teams/:teamId/members/:memberId";');
    expect(route).toContain(
      'params: { "teamId": string; "memberId": string };'
    );

    expect(
      await project.generated(
        'types/src/routes/teams/$teamId/+types/teams/$teamId/_middleware.d.ts'
      )
    ).toContain('path: "/teams/:teamId";');
    expect(
      await project.generated('types/src/routes/+types/health.d.ts')
    ).toContain('params: Record<never, never>;');
  });
});

test('the manifest and every generated file record the format that wrote them', async () => {
  await withProject('manifest', async (project) => {
    await project.write('src/routes/_middleware.ts', middleware());
    await project.write('src/routes/health.ts', GET_ROUTE);
    await project.write('src/routes/admin.ts', SUB_ROUTER);
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

    const notice = `Generated by Shinro (format ${GENERATED_FORMAT}). Do not edit.`;
    expect(await project.generated('routes.ts')).toContain(`// ${notice}`);
    expect(await project.generated('client.ts')).toContain(`// ${notice}`);
    expect(
      await project.generated('types/src/routes/+types/health.d.ts')
    ).toContain(`// ${notice}`);
    expect(await project.generated('manifest.json')).toContain(notice);
  });
});

test('app middleware that can respond early is reported as missing from the client', async () => {
  await withProject(
    'early-response',
    async (project) => {
      await project.write('src/routes/health.ts', GET_ROUTE);
      await project.generate();

      expect(project.warnings.join('\n')).toMatch(
        /has app middleware that can respond early/
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
