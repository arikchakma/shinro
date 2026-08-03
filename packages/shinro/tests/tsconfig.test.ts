import { expect, test } from 'vite-plus/test';

import { withTypedProject } from './typecheck.ts';

test('the shipped tsconfig alone keeps the generated RPC schema', async () => {
  await withTypedProject('shipped-tsconfig', async (project) => {
    await project.write(
      'src/consumer.ts',
      [
        "import type { Client } from '#shinro/client';",
        '',
        "export type Health = Client['health']['$get'];",
        '',
      ].join('\n')
    );
    await project.generate();

    expect(await project.check()).toBe('');
  });
});

test('a tsconfig without the Web APIs fails on the generated schema guard', async () => {
  // What `shinro/tsconfig` used to ship.
  await withTypedProject(
    'no-web-apis',
    async (project) => {
      await project.generate();
      const output = await project.check();

      expect(output).toContain('routes.ts');
      expect(output).toContain(
        'Hono kept no RPC schema, so the client has no routes'
      );
      expect(output).toContain('compilerOptions.lib');
    },
    { compilerOptions: { lib: ['es2023'] } }
  );
});

test('the schema guard is left out when there are no routes to lose', async () => {
  await withTypedProject('no-routes', async (project) => {
    await project.write('src/routes/health.ts', '');
    await project.generate();

    expect(await project.generated('routes.ts')).not.toContain(
      'ShinroSchemaCheck'
    );
  });
});
