import type { InferResponseType } from 'hono/client';
import { testClient } from 'hono/testing';
import { expect, expectTypeOf, test } from 'vite-plus/test';

import { defineClient } from '../.shinro/client.ts';
import app from './fixtures/basic/src/app.ts';

const client = testClient(app);

test('every method export reaches runtime and the RPC client', async () => {
  const get = await client.health.$get();
  const head = await app.request('/health', { method: 'HEAD' });
  const post = await client.health.$post();

  expect(get.status).toBe(200);
  await expect(get.json()).resolves.toEqual({ ok: true });
  expect(head.status).toBe(200);
  await expect(head.text()).resolves.toBe('');
  expect(post.status).toBe(201);
  await expect(post.json()).resolves.toEqual({ created: true });

  await expect(client.verbs.$put().then((r) => r.json())).resolves.toEqual({
    method: 'PUT',
  });
  await expect(client.verbs.$patch().then((r) => r.json())).resolves.toEqual({
    method: 'PATCH',
  });
  await expect(client.verbs.$delete().then((r) => r.json())).resolves.toEqual({
    method: 'DELETE',
  });
  await expect(client.verbs.$options().then((r) => r.json())).resolves.toEqual({
    method: 'OPTIONS',
  });
});

test('the assembled app keeps one Hono instance and its manual routes', async () => {
  const paths = app.routes.map((route) => route.path);

  expect(paths).toContain('/health');
  expect(paths).toContain('/manual');
  expect(paths).not.toContain('/ignored.spec.route');

  await expect(client.manual.$get().then((r) => r.json())).resolves.toEqual({
    manual: true,
  });
  await expect(client.whoami.$get().then((r) => r.json())).resolves.toEqual({
    requestId: 'req_123',
  });
});

test('directory middleware runs, in order, for its directory and descendants', async () => {
  const response = await app.request('/api');

  expect(response.headers.get('x-middleware-order')).toBe('first,second');
  await expect(response.json()).resolves.toEqual({ route: 'api' });

  const descendant = await app.request('/api/users');
  expect(descendant.headers.get('x-middleware-order')).toBe('first,second');

  const outside = await app.request('/health');
  expect(outside.headers.get('x-middleware-order')).toBeNull();
});

test('composing directory middleware preserves a short circuit', async () => {
  const denied = await app.request('/secure');
  expect(denied.status).toBe(401);
  await expect(denied.json()).resolves.toEqual({ error: 'UNAUTHORIZED' });

  const allowed = await app.request('/secure', {
    headers: { authorization: 'Bearer valid' },
  });
  expect(allowed.status).toBe(200);
  await expect(allowed.json()).resolves.toEqual({ secret: true });

  expectTypeOf<
    InferResponseType<typeof client.secure.$get, 401>
  >().toEqualTypeOf<{ error: 'UNAUTHORIZED' }>();
});

test('group directories and route-local middleware wrap without a URL segment', async () => {
  const scoped = await client.scoped.$get();

  expect(scoped.status).toBe(200);
  expect(scoped.headers.get('x-group')).toBe('grouped');
  await expect(scoped.json()).resolves.toEqual({ scoped: true });

  const pipeline = await client.pipeline.$get();

  expect(pipeline.headers.get('x-pipeline-first')).toBe('yes');
  expect(pipeline.headers.get('x-pipeline-second')).toBe('yes');
  await expect(pipeline.json()).resolves.toEqual({ complete: true });

  await expect(client.local.$get().then((r) => r.json())).resolves.toEqual({
    requestId: 'req_local',
  });
});

test('a default Hono sub-router runs at its mount and appears on the client', async () => {
  await expect(client.admin.$get().then((r) => r.json())).resolves.toEqual({
    section: 'admin',
  });
  await expect(
    client.admin.stats.$get().then((r) => r.json())
  ).resolves.toEqual({ activeUsers: 42 });
});

test('filename parameters reach the handler and the client', async () => {
  const single = await client.api.users[':id'].$get({ param: { id: 'u_1' } });
  const nested = await client.teams[':teamId'].members[':memberId'].$get({
    param: { memberId: 'm_2', teamId: 't_1' },
  });
  const catchAll = await app.request('/files/a/b/c.txt');

  await expect(single.json()).resolves.toEqual({ id: 'u_1' });
  await expect(nested.json()).resolves.toEqual({
    memberId: 'm_2',
    teamId: 't_1',
  });
  await expect(catchAll.json()).resolves.toEqual({ path: 'a/b/c.txt' });
});

test('validators accumulate into the handler and the RPC contract', async () => {
  const valid = await client.validated[':id'].$get({ param: { id: 'abc' } });
  expect(valid.status).toBe(200);
  await expect(valid.json()).resolves.toEqual({ id: 'abc' });

  const invalid = await app.request('/validated/ab');
  expect(invalid.status).toBe(400);

  const patched = await client.validated[':id'].$patch({
    json: { name: 'Ada' },
    param: { id: 'abc' },
  });
  expect(patched.status).toBe(200);
  await expect(patched.json()).resolves.toEqual({ id: 'abc', name: 'Ada' });
});

test('the generated client exposes the assembled application contract', () => {
  const generated = defineClient('http://localhost');

  expectTypeOf(generated.health.$get).toBeFunction();
  expectTypeOf(generated.manual.$get).toBeFunction();
  expectTypeOf(generated.admin.stats.$get).toBeFunction();
  expectTypeOf(generated.validated[':id'].$patch)
    .parameter(0)
    .toMatchObjectType<{ json: { name: string }; param: { id: string } }>();
});
