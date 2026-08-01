import { testClient } from 'hono/testing';
import { expect, expectTypeOf, test } from 'vite-plus/test';

import app from '../src/app.ts';

const client = testClient(app);

test('the showcase serves every filename convention it demonstrates', async () => {
  const index = await client.v1.$get();
  const body = await index.json();
  const head = await app.request('/v1/health', { method: 'HEAD' });
  const member = await client.v1.teams[':teamId'].members[':memberId'].$get({
    param: { memberId: 'member_456', teamId: 'team_123' },
  });
  const file = await app.request('/v1/files/guides/getting-started.md');
  const sitemap = await app.request('/v1/sitemap.xml');
  const missing = await app.request('/not-a-route');

  expect(index.status).toBe(200);
  expect(index.headers.get('x-request-id')).toBe(body.requestId);
  expect(body.name).toBe('Shinro API showcase');
  expect(body.endpoints).toContain('/v1/resources/:id');

  expect(head.status).toBe(200);
  await expect(head.text()).resolves.toBe('');

  await expect(member.json()).resolves.toEqual({
    memberId: 'member_456',
    teamId: 'team_123',
  });
  await expect(file.json()).resolves.toEqual({
    path: 'guides/getting-started.md',
  });

  expect(sitemap.headers.get('content-type')).toContain('application/xml');
  await expect(sitemap.text()).resolves.toBe('<urlset />');

  expect(missing.status).toBe(404);
  await expect(missing.json()).resolves.toEqual({ error: 'NOT_FOUND' });
});

test('validated collection and resource routes type their responses', async () => {
  const listed = await client.v1.resources.$get({
    query: { limit: '5', query: 'example' },
  });
  const created = await client.v1.resources.$post({
    json: { name: 'Created through RPC' },
  });
  const found = await client.v1.resources[':id'].$get({
    param: { id: 'res_123' },
  });
  const missing = await client.v1.resources[':id'].$get({
    param: { id: 'missing' },
  });
  const updated = await client.v1.resources[':id'].$patch({
    json: { name: 'Updated resource' },
    param: { id: 'res_123' },
  });
  const deleted = await client.v1.resources[':id'].$delete({
    param: { id: 'res_123' },
  });

  expectTypeOf(created.status).toEqualTypeOf<201 | 400>();
  await expect(listed.json()).resolves.toMatchObject({
    input: { limit: 5, query: 'example' },
    resources: [{ id: 'res_123' }, { id: 'res_456' }],
  });
  await expect(created.json()).resolves.toEqual({
    resource: { id: 'res_new', name: 'Created through RPC' },
  });
  await expect(found.json()).resolves.toMatchObject({
    resource: { id: 'res_123' },
  });
  expect(missing.status).toBe(404);
  await expect(missing.json()).resolves.toEqual({
    error: 'RESOURCE_NOT_FOUND',
  });
  await expect(updated.json()).resolves.toMatchObject({
    resource: { id: 'res_123', name: 'Updated resource' },
  });
  await expect(deleted.json()).resolves.toEqual({ deleted: 'res_123' });
});

test('middleware runs in order, protects descendants, and survives grouping', async () => {
  const order = 'root:first,root:second';
  const pipeline = await client.v1.pipeline.$get();
  const denied = await app.request('/v1/protected');
  const allowed = await app.request('/v1/protected', {
    headers: { authorization: 'Bearer demo' },
  });
  const groupDenied = await app.request('/v1/orders');
  const groupAllowed = await app.request('/v1/orders', {
    headers: { authorization: 'Bearer demo' },
  });

  expect(pipeline.headers.get('x-middleware-order')).toBe(order);
  await expect(pipeline.json()).resolves.toEqual({
    order: ['first', 'second'],
  });

  expect(denied.status).toBe(401);
  expect(denied.headers.get('x-middleware-order')).toBe(order);
  await expect(denied.json()).resolves.toEqual({ error: 'UNAUTHORIZED' });
  expect(allowed.status).toBe(200);
  await expect(allowed.json()).resolves.toMatchObject({ secret: 'shinro' });

  expect(groupDenied.status).toBe(401);
  expect(groupAllowed.status).toBe(200);
  await expect(groupAllowed.json()).resolves.toMatchObject({
    orders: ['ord_1', 'ord_2'],
  });
  expect((await app.request('/v1/(authed)/orders')).status).toBe(404);
});

test('sub-routers, manual routes, and the remaining methods stay on the client', async () => {
  const admin = await client.v1.admin.$get();
  const stats = await client.v1.admin.stats.$get();
  const manual = await client.v1.manual.$get();
  const manualBody = await manual.json();

  expect(admin.headers.get('x-middleware-order')).toBe(
    'root:first,root:second'
  );
  await expect(admin.json()).resolves.toEqual({ section: 'admin' });
  await expect(stats.json()).resolves.toEqual({ activeRoutes: 13 });

  expect(manual.headers.get('x-request-id')).toBe(manualBody.requestId);
  expect(manualBody.feature).toBe('manual-route');

  await expect(client.v1.methods.$put().then((r) => r.json())).resolves.toEqual(
    {
      method: 'PUT',
    }
  );
  await expect(
    client.v1.methods.$patch().then((r) => r.json())
  ).resolves.toEqual({ method: 'PATCH' });
  await expect(
    client.v1.methods.$delete().then((r) => r.json())
  ).resolves.toEqual({ method: 'DELETE' });
  await expect(
    client.v1.methods.$options().then((r) => r.json())
  ).resolves.toEqual({ method: 'OPTIONS' });
});
