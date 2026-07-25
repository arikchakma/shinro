import { testClient } from 'hono/testing';
import { expect, expectTypeOf, test } from 'vite-plus/test';

import app from '../src/app.ts';

const client = testClient(app);

test('the index route describes the versioned showcase', async () => {
  const response = await client.v1.$get();
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(response.headers.get('x-middleware-order')).toBe(
    'root:first,root:second'
  );
  expect(response.headers.get('x-request-id')).toBe(body.requestId);
  expect(body.name).toBe('Shinro API showcase');
  expect(body.endpoints).toContain('/v1/resources/:id');
});

test('a minimal GET route also handles HEAD without a body', async () => {
  const get = await client.v1.health.$get();
  const head = await app.request('/v1/health', { method: 'HEAD' });

  expectTypeOf(get.status).toEqualTypeOf<200>();
  expect(get.status).toBe(200);
  await expect(get.json()).resolves.toMatchObject({ ok: true });
  expect(head.status).toBe(200);
  await expect(head.text()).resolves.toBe('');
});

test('one collection route validates query and JSON input for multiple methods', async () => {
  const listed = await client.v1.resources.$get({
    query: {
      limit: '5',
      query: 'example',
    },
  });
  const created = await client.v1.resources.$post({
    json: {
      name: 'Created through RPC',
    },
  });

  expectTypeOf(created.status).toEqualTypeOf<201 | 400>();
  await expect(listed.json()).resolves.toMatchObject({
    input: {
      limit: 5,
      query: 'example',
    },
  });
  await expect(created.json()).resolves.toEqual({
    resource: {
      id: 'res_new',
      name: 'Created through RPC',
    },
  });
});

test('dynamic resource routes expose typed success, not-found, update, and delete responses', async () => {
  const found = await client.v1.resources[':id'].$get({
    param: {
      id: 'res_123',
    },
  });
  const missing = await client.v1.resources[':id'].$get({
    param: {
      id: 'missing',
    },
  });
  const updated = await client.v1.resources[':id'].$patch({
    param: {
      id: 'res_123',
    },
    json: {
      name: 'Updated resource',
    },
  });
  const deleted = await client.v1.resources[':id'].$delete({
    param: {
      id: 'res_123',
    },
  });

  expect(found.status).toBe(200);
  await expect(found.json()).resolves.toMatchObject({
    resource: {
      id: 'res_123',
    },
  });
  expect(missing.status).toBe(404);
  await expect(missing.json()).resolves.toEqual({
    error: 'RESOURCE_NOT_FOUND',
  });
  await expect(updated.json()).resolves.toMatchObject({
    resource: {
      id: 'res_123',
      name: 'Updated resource',
    },
  });
  await expect(deleted.json()).resolves.toEqual({
    deleted: 'res_123',
  });
});

test('nested dynamic and catch-all filenames map to their request parameters', async () => {
  const member = await client.v1.teams[':teamId'].members[':memberId'].$get({
    param: {
      memberId: 'member_456',
      teamId: 'team_123',
    },
  });
  const file = await app.request('/v1/files/guides/getting-started.md');

  await expect(member.json()).resolves.toEqual({
    memberId: 'member_456',
    teamId: 'team_123',
  });
  await expect(file.json()).resolves.toEqual({
    path: 'guides/getting-started.md',
  });
});

test('all remaining named HTTP methods are registered', async () => {
  const put = await client.v1.methods.$put();
  const patch = await client.v1.methods.$patch();
  const deleted = await client.v1.methods.$delete();
  const options = await client.v1.methods.$options();

  await expect(put.json()).resolves.toEqual({ method: 'PUT' });
  await expect(patch.json()).resolves.toEqual({ method: 'PATCH' });
  await expect(deleted.json()).resolves.toEqual({ method: 'DELETE' });
  await expect(options.json()).resolves.toEqual({ method: 'OPTIONS' });
});

test('route-local middleware runs in declaration order', async () => {
  const response = await client.v1.pipeline.$get();

  expect(response.headers.get('x-middleware-order')).toBe(
    'root:first,root:second'
  );
  await expect(response.json()).resolves.toEqual({
    order: ['first', 'second'],
  });
});

test('directory middleware contributes an early response and protects descendants', async () => {
  const denied = await app.request('/v1/protected');
  const allowed = await app.request('/v1/protected', {
    headers: {
      authorization: 'Bearer demo',
    },
  });

  expect(denied.status).toBe(401);
  expect(denied.headers.get('x-middleware-order')).toBe(
    'root:first,root:second'
  );
  await expect(denied.json()).resolves.toEqual({
    error: 'UNAUTHORIZED',
  });
  expect(allowed.status).toBe(200);
  await expect(allowed.json()).resolves.toMatchObject({
    secret: 'shinro',
  });
});

test('a default sub-router retains internal RPC routes and inherited runtime middleware', async () => {
  const index = await client.v1.admin.$get();
  const stats = await client.v1.admin.stats.$get();

  expect(index.headers.get('x-middleware-order')).toBe(
    'root:first,root:second'
  );
  await expect(index.json()).resolves.toEqual({
    section: 'admin',
  });
  await expect(stats.json()).resolves.toEqual({
    activeRoutes: 13,
  });
});

test('a chained manual route remains in the RPC schema', async () => {
  const response = await client.v1.manual.$get();
  const body = await response.json();

  expect(response.headers.get('x-request-id')).toBe(body.requestId);
  expect(body.feature).toBe('manual-route');
});

test('the configured app owns its not-found response', async () => {
  const response = await app.request('/not-a-route');

  expect(response.status).toBe(404);
  await expect(response.json()).resolves.toEqual({
    error: 'NOT_FOUND',
  });
});

test('a group directory protects its routes without appearing in their URLs', async () => {
  const denied = await app.request('/v1/orders');
  const allowed = await app.request('/v1/orders', {
    headers: {
      authorization: 'Bearer demo',
    },
  });

  expect(denied.status).toBe(401);
  await expect(denied.json()).resolves.toEqual({ error: 'UNAUTHORIZED' });
  expect(allowed.status).toBe(200);
  await expect(allowed.json()).resolves.toMatchObject({
    orders: ['ord_1', 'ord_2'],
  });

  // The group names no URL segment, and the sibling outside it stays public.
  expect((await app.request('/v1/(authed)/orders')).status).toBe(404);
  expect((await app.request('/v1/health')).status).toBe(200);
});

test('an escaped filename serves its literal URL', async () => {
  const response = await app.request('/v1/sitemap.xml');

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/xml');
  await expect(response.text()).resolves.toBe('<urlset />');
});
