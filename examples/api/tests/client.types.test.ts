import { expectTypeOf, test } from 'vite-plus/test';

import type {
  Client,
  InferRequestType,
  InferResponseType,
} from '../.shinro/client.ts';

type CreateResource = Client['v1']['resources']['$post'];
type GetResource = Client['v1']['resources'][':id']['$get'];
type PatchResource = Client['v1']['resources'][':id']['$patch'];
type GetMember =
  Client['v1']['teams'][':teamId']['members'][':memberId']['$get'];
type GetProtected = Client['v1']['protected']['$get'];
type GetOrders = Client['v1']['orders']['$get'];
type OrdersResponse = Awaited<ReturnType<GetOrders>>;
type ProtectedResponse = Awaited<ReturnType<GetProtected>>;

test('the generated client exposes validated request inputs', () => {
  expectTypeOf<InferRequestType<CreateResource>['json']>().toEqualTypeOf<{
    name: string;
  }>();
  expectTypeOf<InferRequestType<GetResource>['param']>().toEqualTypeOf<{
    id: string;
  }>();
});

test('a route with two validators keeps both inputs in the contract', () => {
  expectTypeOf<InferRequestType<PatchResource>['param']>().toEqualTypeOf<{
    id: string;
  }>();
  expectTypeOf<InferRequestType<PatchResource>['json']>().toEqualTypeOf<{
    name: string;
  }>();
});

test('filename parameters and middleware responses reach the generated client', () => {
  expectTypeOf<InferRequestType<GetMember>['param']>().toMatchTypeOf<{
    memberId: string;
    teamId: string;
  }>();
  expectTypeOf<ProtectedResponse['status']>().toEqualTypeOf<200 | 401>();
  expectTypeOf<InferResponseType<GetProtected>>().toEqualTypeOf<
    { error: 'UNAUTHORIZED' } | { requestId: string; secret: 'shinro' }
  >();
});

test('manual and default sub-router paths are retained by RPC generation', () => {
  expectTypeOf<Client['v1']['manual']['$get']>().toBeFunction();
  expectTypeOf<Client['v1']['admin']['stats']['$get']>().toBeFunction();
});

test('a grouped route keeps its middleware response but drops the group segment', () => {
  expectTypeOf<OrdersResponse['status']>().toEqualTypeOf<200 | 401>();
  expectTypeOf<InferResponseType<GetOrders>>().toEqualTypeOf<
    | { error: 'UNAUTHORIZED' }
    | { orders: ['ord_1', 'ord_2']; requestId: string }
  >();
});
