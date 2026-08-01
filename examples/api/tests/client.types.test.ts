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

test('the generated client keeps validators, parameters, and paths', () => {
  expectTypeOf<InferRequestType<CreateResource>['json']>().toEqualTypeOf<{
    name: string;
  }>();
  expectTypeOf<InferRequestType<GetResource>['param']>().toEqualTypeOf<{
    id: string;
  }>();
  expectTypeOf<InferRequestType<PatchResource>['param']>().toEqualTypeOf<{
    id: string;
  }>();
  expectTypeOf<InferRequestType<PatchResource>['json']>().toEqualTypeOf<{
    name: string;
  }>();
  expectTypeOf<InferRequestType<GetMember>['param']>().toMatchTypeOf<{
    memberId: string;
    teamId: string;
  }>();
  expectTypeOf<Client['v1']['manual']['$get']>().toBeFunction();
  expectTypeOf<Client['v1']['admin']['stats']['$get']>().toBeFunction();
});

test('middleware responses stay in the response union, group segment or not', () => {
  expectTypeOf<Awaited<ReturnType<GetProtected>>['status']>().toEqualTypeOf<
    200 | 401
  >();
  expectTypeOf<InferResponseType<GetProtected>>().toEqualTypeOf<
    { error: 'UNAUTHORIZED' } | { requestId: string; secret: 'shinro' }
  >();
  expectTypeOf<Awaited<ReturnType<GetOrders>>['status']>().toEqualTypeOf<
    200 | 401
  >();
  expectTypeOf<InferResponseType<GetOrders>>().toEqualTypeOf<
    | { error: 'UNAUTHORIZED' }
    | { orders: ['ord_1', 'ord_2']; requestId: string }
  >();
});
