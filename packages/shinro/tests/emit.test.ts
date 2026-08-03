import {
  chmod,
  mkdir,
  readdir,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { resolve } from 'node:path';

import { expect, test } from 'vite-plus/test';

import { GENERATED_FORMAT, STAGING_DIRECTORY } from '../src/constants.ts';
import { emit } from '../src/core/emit.ts';
import { GET_ROUTE, middleware, route, withProject } from './helpers.ts';

test('regenerating an unchanged tree writes nothing and touches nothing', async () => {
  await withProject('idempotent', async (project) => {
    await project.write('src/routes/_middleware.ts', middleware(2));
    await project.write('src/routes/health.ts', GET_ROUTE);
    await project.write('src/routes/users/$id.ts', GET_ROUTE);
    await project.generate();

    const first = {
      client: await project.generated('client.ts'),
      manifest: await project.generated('manifest.json'),
      routes: await project.generated('routes.ts'),
    };
    const routesFile = resolve(project.outputDirectory, 'routes.ts');
    const earlier = new Date('2020-01-02T03:04:05.000Z');
    await utimes(routesFile, earlier, earlier);

    const second = await project.generate();

    // Matching bytes are not enough: generation runs on every restart, so a
    // bumped mtime is another restart and the loop never settles.
    expect(second.written).toEqual([]);
    expect((await stat(routesFile)).mtimeMs).toBe(earlier.getTime());
    expect({
      client: await project.generated('client.ts'),
      manifest: await project.generated('manifest.json'),
      routes: await project.generated('routes.ts'),
    }).toEqual(first);
    expect(first.manifest).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(first.routes).not.toContain(project.root);
    expect(await readdir(project.outputDirectory)).toEqual(
      expect.not.arrayContaining(['.staging'])
    );
  });
});

test('every generation stages through the same path', async () => {
  await withProject('staging-path', async (project) => {
    const staging = resolve(project.outputDirectory, STAGING_DIRECTORY);
    const seen = new Set<string>();
    let polling = true;

    const poll = (async () => {
      while (polling) {
        for (const name of await readdir(staging).catch(() => [])) {
          seen.add(name);
        }
      }
    })();

    try {
      for (let round = 0; round < 8; round += 1) {
        await emit(
          project.outputDirectory,
          new Map(
            Array.from({ length: 40 }, (_, index) => [
              resolve(project.outputDirectory, `types/staged-${index}.d.ts`),
              `// round ${round}\nexport {};\n`,
            ])
          )
        );
      }
    } finally {
      polling = false;
      await poll;
    }

    expect([...seen]).toEqual([String(process.pid)]);
    expect(await readdir(project.outputDirectory)).toEqual(
      expect.not.arrayContaining([STAGING_DIRECTORY])
    );
  });
});

test('generations that overlap do not stage over each other', async () => {
  await withProject('staging-overlap', async (project) => {
    const files = (round: number): Map<string, string> =>
      new Map(
        Array.from({ length: 20 }, (_, index) => [
          resolve(project.outputDirectory, `types/overlap-${index}.d.ts`),
          `// round ${round}\nexport {};\n`,
        ])
      );

    const results = await Promise.all([
      emit(project.outputDirectory, files(1)),
      emit(project.outputDirectory, files(2)),
      emit(project.outputDirectory, files(3)),
    ]);

    expect(results.every((result) => result.written.length === 20)).toBe(true);
    for (let index = 0; index < 20; index += 1) {
      const contents = await project.generated(`types/overlap-${index}.d.ts`);
      expect(contents).toMatch(/^\/\/ round [123]\nexport \{\};\n$/);
    }
  });
});

test('a failure leaves the previous generation exactly as it was', async () => {
  await withProject('failure-isolation', async (project) => {
    await project.write('src/routes/health.ts', route('{ ok: true }'));
    await project.generate();
    const before = await project.generated('routes.ts');

    await project.write('src/routes/health/index.ts', GET_ROUTE);
    await expect(project.generate()).rejects.toThrow(/Route conflict/);
    expect(await project.generated('routes.ts')).toBe(before);

    await project.remove('src/routes/health/index.ts');
    await project.write('src/routes/extra.ts', GET_ROUTE);
    await chmod(project.outputDirectory, 0o500);

    try {
      await expect(project.generate()).rejects.toThrow();
      expect(await project.generated('routes.ts')).toBe(before);
    } finally {
      await chmod(project.outputDirectory, 0o700);
    }
  });
});

test('a write that cannot land fails before anything is written', async () => {
  await withProject('directory-collision', async (project) => {
    await project.write('src/routes/health.ts', GET_ROUTE);
    await mkdir(resolve(project.outputDirectory, 'routes.ts'), {
      recursive: true,
    });

    await expect(project.generate()).rejects.toThrow(
      /a directory exists where a generated file is required/
    );
  });

  await withProject('escape', async (project) => {
    await project.write('src/routes/health.ts', GET_ROUTE);

    // `getTypeDeclarationPath` builds paths from the route tree, so this is the
    // guard that keeps a route file outside the project from steering a write.
    await expect(project.generate({ routes: '../outside' })).rejects.toThrow();
  });
});

test('a route that disappears takes its stale declaration with it', async () => {
  await withProject('pruning', async (project) => {
    await project.write('src/routes/health.ts', GET_ROUTE);
    await project.write('src/routes/legacy.ts', GET_ROUTE);
    await project.generate();
    await expect(
      project.generated('types/src/routes/+types/legacy.d.ts')
    ).resolves.toContain('/legacy');

    await project.remove('src/routes/legacy.ts');
    const result = await project.generate();

    expect(result.removed).toEqual([
      resolve(project.outputDirectory, 'types/src/routes/+types/legacy.d.ts'),
    ]);
    await expect(
      project.generated('types/src/routes/+types/legacy.d.ts')
    ).rejects.toThrow();
  });
});

test('artifacts of an older format are removed, hand-written files are not', async () => {
  await withProject('legacy', async (project) => {
    await project.write('src/routes/health.ts', GET_ROUTE);
    await project.generate();

    // Left behind, a format-2 `shinro.d.ts` keeps type-checking a specifier that
    // no longer resolves.
    await writeFile(
      resolve(project.outputDirectory, 'shinro.d.ts'),
      '// Generated by Shinro (format 2). Do not edit.\ndeclare module "shinro/routes" {}\n'
    );
    await writeFile(
      resolve(project.outputDirectory, 'notes.md'),
      "# mine, not Shinro's\n"
    );

    await project.generate();

    const entries = await readdir(project.outputDirectory);
    expect(entries).not.toContain('shinro.d.ts');
    expect(entries).toContain('notes.md');
  });
});

test('--check reports drift without repairing it', async () => {
  await withProject('check', async (project) => {
    await project.write('src/routes/health.ts', GET_ROUTE);
    await project.generate();

    const routesFile = resolve(project.outputDirectory, 'routes.ts');
    const earlier = new Date('2021-02-03T04:05:06.000Z');
    await utimes(routesFile, earlier, earlier);

    const clean = await project.check();

    expect(clean.written).toEqual([]);
    expect(clean.removed).toEqual([]);
    expect((await stat(routesFile)).mtimeMs).toBe(earlier.getTime());

    await project.write('src/routes/extra.ts', GET_ROUTE);
    const drifted = await project.check();

    expect(drifted.written).toContain(routesFile);
    expect(await project.generated('routes.ts')).not.toContain('/extra');
  });
});

test('--check tells an upgrade apart from a stale tree', async () => {
  await withProject('check-format', async (project) => {
    await project.write('src/routes/health.ts', GET_ROUTE);
    await project.generate();

    const manifest = JSON.parse(await project.generated('manifest.json')) as {
      format: number;
    };
    await writeFile(
      resolve(project.outputDirectory, 'manifest.json'),
      `${JSON.stringify({ ...manifest, format: GENERATED_FORMAT - 1 }, undefined, 2)}\n`
    );

    const result = await project.check();

    expect(result.onDiskFormat).toBe(GENERATED_FORMAT - 1);
    expect(result.written.length).toBeGreaterThan(0);
  });
});
