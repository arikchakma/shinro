import type { Env } from 'hono';
import { createFactory } from 'hono/factory';
import type { Factory } from 'hono/factory';
import type {
  BlankInput,
  H,
  Handler,
  HandlerResponse,
  Input,
} from 'hono/types';

import type { ProjectEnv } from '../app.ts';

export type ShinroRoute<
  T extends {
    env: Env;
    params: Record<string, string>;
    path: string;
  },
> = T;

type AnyRoute = ShinroRoute<{
  env: Env;
  params: Record<string, string>;
  path: string;
}>;

type RouteEnv<Route extends AnyRoute | undefined> = Route extends AnyRoute
  ? Route['env']
  : ProjectEnv;

type RoutePath<Route extends AnyRoute | undefined> = Route extends AnyRoute
  ? Route['path']
  : string;

/**
 * A ladder mirroring `hono/factory`, one signature per arity up to ten.
 *
 * Accumulation rides on the generic defaults: each input falls back to the
 * intersection of the ones before it, so the final handler — which has no
 * inference source of its own — sees every validator that precedes it.
 *
 * Those defaults are also the ceiling on the generated route generic. Supplying
 * `Route` explicitly stops TypeScript inferring the parameters after it, so the
 * inputs stay `BlankInput` however many validators precede the handler: the
 * chain still runs and still shapes the RPC contract, but `c.req.valid()` has
 * nothing to read. Middleware carries no input of its own and so pairs with the
 * generic freely, which is why the leading positions stay open in both forms.
 * They each take an `Env` slot because a hoisted handler declares plain `Env`
 * rather than the project's.
 */
type DefineHandler = {
  <
    Route extends AnyRoute | undefined = undefined,
    I extends Input = BlankInput,
    R extends HandlerResponse<any> = HandlerResponse<any>,
  >(
    handler: Handler<RouteEnv<Route>, RoutePath<Route>, I, R>
  ): [Handler<RouteEnv<Route>, RoutePath<Route>, I, R>];
  <
    Route extends AnyRoute | undefined = undefined,
    I extends Input = BlankInput,
    I2 extends Input = I,
    R1 extends HandlerResponse<any> = HandlerResponse<any>,
    R2 extends HandlerResponse<any> = HandlerResponse<any>,
    E extends Env = RouteEnv<Route>,
  >(
    middleware1: H<E, RoutePath<Route>, I, R1>,
    handler: Handler<RouteEnv<Route>, RoutePath<Route>, I2, R2>
  ): [
    H<E, RoutePath<Route>, I, R1>,
    Handler<RouteEnv<Route>, RoutePath<Route>, I2, R2>,
  ];
  <
    Route extends AnyRoute | undefined = undefined,
    I extends Input = BlankInput,
    I2 extends Input = I,
    I3 extends Input = I & I2,
    R1 extends HandlerResponse<any> = HandlerResponse<any>,
    R2 extends HandlerResponse<any> = HandlerResponse<any>,
    R3 extends HandlerResponse<any> = HandlerResponse<any>,
    E extends Env = RouteEnv<Route>,
    E2 extends Env = RouteEnv<Route>,
  >(
    middleware1: H<E, RoutePath<Route>, I, R1>,
    middleware2: H<E2, RoutePath<Route>, I2, R2>,
    handler: Handler<RouteEnv<Route>, RoutePath<Route>, I3, R3>
  ): [
    H<E, RoutePath<Route>, I, R1>,
    H<E2, RoutePath<Route>, I2, R2>,
    Handler<RouteEnv<Route>, RoutePath<Route>, I3, R3>,
  ];
  <
    Route extends AnyRoute | undefined = undefined,
    I extends Input = BlankInput,
    I2 extends Input = I,
    I3 extends Input = I & I2,
    I4 extends Input = I & I2 & I3,
    R1 extends HandlerResponse<any> = HandlerResponse<any>,
    R2 extends HandlerResponse<any> = HandlerResponse<any>,
    R3 extends HandlerResponse<any> = HandlerResponse<any>,
    R4 extends HandlerResponse<any> = HandlerResponse<any>,
    E extends Env = RouteEnv<Route>,
    E2 extends Env = RouteEnv<Route>,
    E3 extends Env = RouteEnv<Route>,
  >(
    middleware1: H<E, RoutePath<Route>, I, R1>,
    middleware2: H<E2, RoutePath<Route>, I2, R2>,
    middleware3: H<E3, RoutePath<Route>, I3, R3>,
    handler: Handler<RouteEnv<Route>, RoutePath<Route>, I4, R4>
  ): [
    H<E, RoutePath<Route>, I, R1>,
    H<E2, RoutePath<Route>, I2, R2>,
    H<E3, RoutePath<Route>, I3, R3>,
    Handler<RouteEnv<Route>, RoutePath<Route>, I4, R4>,
  ];
  <
    Route extends AnyRoute | undefined = undefined,
    I extends Input = BlankInput,
    I2 extends Input = I,
    I3 extends Input = I & I2,
    I4 extends Input = I & I2 & I3,
    I5 extends Input = I & I2 & I3 & I4,
    R1 extends HandlerResponse<any> = HandlerResponse<any>,
    R2 extends HandlerResponse<any> = HandlerResponse<any>,
    R3 extends HandlerResponse<any> = HandlerResponse<any>,
    R4 extends HandlerResponse<any> = HandlerResponse<any>,
    R5 extends HandlerResponse<any> = HandlerResponse<any>,
    E extends Env = RouteEnv<Route>,
    E2 extends Env = RouteEnv<Route>,
    E3 extends Env = RouteEnv<Route>,
    E4 extends Env = RouteEnv<Route>,
  >(
    middleware1: H<E, RoutePath<Route>, I, R1>,
    middleware2: H<E2, RoutePath<Route>, I2, R2>,
    middleware3: H<E3, RoutePath<Route>, I3, R3>,
    middleware4: H<E4, RoutePath<Route>, I4, R4>,
    handler: Handler<RouteEnv<Route>, RoutePath<Route>, I5, R5>
  ): [
    H<E, RoutePath<Route>, I, R1>,
    H<E2, RoutePath<Route>, I2, R2>,
    H<E3, RoutePath<Route>, I3, R3>,
    H<E4, RoutePath<Route>, I4, R4>,
    Handler<RouteEnv<Route>, RoutePath<Route>, I5, R5>,
  ];
  <
    Route extends AnyRoute | undefined = undefined,
    I extends Input = BlankInput,
    I2 extends Input = I,
    I3 extends Input = I & I2,
    I4 extends Input = I & I2 & I3,
    I5 extends Input = I & I2 & I3 & I4,
    I6 extends Input = I & I2 & I3 & I4 & I5,
    R1 extends HandlerResponse<any> = HandlerResponse<any>,
    R2 extends HandlerResponse<any> = HandlerResponse<any>,
    R3 extends HandlerResponse<any> = HandlerResponse<any>,
    R4 extends HandlerResponse<any> = HandlerResponse<any>,
    R5 extends HandlerResponse<any> = HandlerResponse<any>,
    R6 extends HandlerResponse<any> = HandlerResponse<any>,
    E extends Env = RouteEnv<Route>,
    E2 extends Env = RouteEnv<Route>,
    E3 extends Env = RouteEnv<Route>,
    E4 extends Env = RouteEnv<Route>,
    E5 extends Env = RouteEnv<Route>,
  >(
    middleware1: H<E, RoutePath<Route>, I, R1>,
    middleware2: H<E2, RoutePath<Route>, I2, R2>,
    middleware3: H<E3, RoutePath<Route>, I3, R3>,
    middleware4: H<E4, RoutePath<Route>, I4, R4>,
    middleware5: H<E5, RoutePath<Route>, I5, R5>,
    handler: Handler<RouteEnv<Route>, RoutePath<Route>, I6, R6>
  ): [
    H<E, RoutePath<Route>, I, R1>,
    H<E2, RoutePath<Route>, I2, R2>,
    H<E3, RoutePath<Route>, I3, R3>,
    H<E4, RoutePath<Route>, I4, R4>,
    H<E5, RoutePath<Route>, I5, R5>,
    Handler<RouteEnv<Route>, RoutePath<Route>, I6, R6>,
  ];
  <
    Route extends AnyRoute | undefined = undefined,
    I extends Input = BlankInput,
    I2 extends Input = I,
    I3 extends Input = I & I2,
    I4 extends Input = I & I2 & I3,
    I5 extends Input = I & I2 & I3 & I4,
    I6 extends Input = I & I2 & I3 & I4 & I5,
    I7 extends Input = I & I2 & I3 & I4 & I5 & I6,
    R1 extends HandlerResponse<any> = HandlerResponse<any>,
    R2 extends HandlerResponse<any> = HandlerResponse<any>,
    R3 extends HandlerResponse<any> = HandlerResponse<any>,
    R4 extends HandlerResponse<any> = HandlerResponse<any>,
    R5 extends HandlerResponse<any> = HandlerResponse<any>,
    R6 extends HandlerResponse<any> = HandlerResponse<any>,
    R7 extends HandlerResponse<any> = HandlerResponse<any>,
    E extends Env = RouteEnv<Route>,
    E2 extends Env = RouteEnv<Route>,
    E3 extends Env = RouteEnv<Route>,
    E4 extends Env = RouteEnv<Route>,
    E5 extends Env = RouteEnv<Route>,
    E6 extends Env = RouteEnv<Route>,
  >(
    middleware1: H<E, RoutePath<Route>, I, R1>,
    middleware2: H<E2, RoutePath<Route>, I2, R2>,
    middleware3: H<E3, RoutePath<Route>, I3, R3>,
    middleware4: H<E4, RoutePath<Route>, I4, R4>,
    middleware5: H<E5, RoutePath<Route>, I5, R5>,
    middleware6: H<E6, RoutePath<Route>, I6, R6>,
    handler: Handler<RouteEnv<Route>, RoutePath<Route>, I7, R7>
  ): [
    H<E, RoutePath<Route>, I, R1>,
    H<E2, RoutePath<Route>, I2, R2>,
    H<E3, RoutePath<Route>, I3, R3>,
    H<E4, RoutePath<Route>, I4, R4>,
    H<E5, RoutePath<Route>, I5, R5>,
    H<E6, RoutePath<Route>, I6, R6>,
    Handler<RouteEnv<Route>, RoutePath<Route>, I7, R7>,
  ];
  <
    Route extends AnyRoute | undefined = undefined,
    I extends Input = BlankInput,
    I2 extends Input = I,
    I3 extends Input = I & I2,
    I4 extends Input = I & I2 & I3,
    I5 extends Input = I & I2 & I3 & I4,
    I6 extends Input = I & I2 & I3 & I4 & I5,
    I7 extends Input = I & I2 & I3 & I4 & I5 & I6,
    I8 extends Input = I & I2 & I3 & I4 & I5 & I6 & I7,
    R1 extends HandlerResponse<any> = HandlerResponse<any>,
    R2 extends HandlerResponse<any> = HandlerResponse<any>,
    R3 extends HandlerResponse<any> = HandlerResponse<any>,
    R4 extends HandlerResponse<any> = HandlerResponse<any>,
    R5 extends HandlerResponse<any> = HandlerResponse<any>,
    R6 extends HandlerResponse<any> = HandlerResponse<any>,
    R7 extends HandlerResponse<any> = HandlerResponse<any>,
    R8 extends HandlerResponse<any> = HandlerResponse<any>,
    E extends Env = RouteEnv<Route>,
    E2 extends Env = RouteEnv<Route>,
    E3 extends Env = RouteEnv<Route>,
    E4 extends Env = RouteEnv<Route>,
    E5 extends Env = RouteEnv<Route>,
    E6 extends Env = RouteEnv<Route>,
    E7 extends Env = RouteEnv<Route>,
  >(
    middleware1: H<E, RoutePath<Route>, I, R1>,
    middleware2: H<E2, RoutePath<Route>, I2, R2>,
    middleware3: H<E3, RoutePath<Route>, I3, R3>,
    middleware4: H<E4, RoutePath<Route>, I4, R4>,
    middleware5: H<E5, RoutePath<Route>, I5, R5>,
    middleware6: H<E6, RoutePath<Route>, I6, R6>,
    middleware7: H<E7, RoutePath<Route>, I7, R7>,
    handler: Handler<RouteEnv<Route>, RoutePath<Route>, I8, R8>
  ): [
    H<E, RoutePath<Route>, I, R1>,
    H<E2, RoutePath<Route>, I2, R2>,
    H<E3, RoutePath<Route>, I3, R3>,
    H<E4, RoutePath<Route>, I4, R4>,
    H<E5, RoutePath<Route>, I5, R5>,
    H<E6, RoutePath<Route>, I6, R6>,
    H<E7, RoutePath<Route>, I7, R7>,
    Handler<RouteEnv<Route>, RoutePath<Route>, I8, R8>,
  ];
  <
    Route extends AnyRoute | undefined = undefined,
    I extends Input = BlankInput,
    I2 extends Input = I,
    I3 extends Input = I & I2,
    I4 extends Input = I & I2 & I3,
    I5 extends Input = I & I2 & I3 & I4,
    I6 extends Input = I & I2 & I3 & I4 & I5,
    I7 extends Input = I & I2 & I3 & I4 & I5 & I6,
    I8 extends Input = I & I2 & I3 & I4 & I5 & I6 & I7,
    I9 extends Input = I & I2 & I3 & I4 & I5 & I6 & I7 & I8,
    R1 extends HandlerResponse<any> = HandlerResponse<any>,
    R2 extends HandlerResponse<any> = HandlerResponse<any>,
    R3 extends HandlerResponse<any> = HandlerResponse<any>,
    R4 extends HandlerResponse<any> = HandlerResponse<any>,
    R5 extends HandlerResponse<any> = HandlerResponse<any>,
    R6 extends HandlerResponse<any> = HandlerResponse<any>,
    R7 extends HandlerResponse<any> = HandlerResponse<any>,
    R8 extends HandlerResponse<any> = HandlerResponse<any>,
    R9 extends HandlerResponse<any> = HandlerResponse<any>,
    E extends Env = RouteEnv<Route>,
    E2 extends Env = RouteEnv<Route>,
    E3 extends Env = RouteEnv<Route>,
    E4 extends Env = RouteEnv<Route>,
    E5 extends Env = RouteEnv<Route>,
    E6 extends Env = RouteEnv<Route>,
    E7 extends Env = RouteEnv<Route>,
    E8 extends Env = RouteEnv<Route>,
  >(
    middleware1: H<E, RoutePath<Route>, I, R1>,
    middleware2: H<E2, RoutePath<Route>, I2, R2>,
    middleware3: H<E3, RoutePath<Route>, I3, R3>,
    middleware4: H<E4, RoutePath<Route>, I4, R4>,
    middleware5: H<E5, RoutePath<Route>, I5, R5>,
    middleware6: H<E6, RoutePath<Route>, I6, R6>,
    middleware7: H<E7, RoutePath<Route>, I7, R7>,
    middleware8: H<E8, RoutePath<Route>, I8, R8>,
    handler: Handler<RouteEnv<Route>, RoutePath<Route>, I9, R9>
  ): [
    H<E, RoutePath<Route>, I, R1>,
    H<E2, RoutePath<Route>, I2, R2>,
    H<E3, RoutePath<Route>, I3, R3>,
    H<E4, RoutePath<Route>, I4, R4>,
    H<E5, RoutePath<Route>, I5, R5>,
    H<E6, RoutePath<Route>, I6, R6>,
    H<E7, RoutePath<Route>, I7, R7>,
    H<E8, RoutePath<Route>, I8, R8>,
    Handler<RouteEnv<Route>, RoutePath<Route>, I9, R9>,
  ];
  <
    Route extends AnyRoute | undefined = undefined,
    I extends Input = BlankInput,
    I2 extends Input = I,
    I3 extends Input = I & I2,
    I4 extends Input = I & I2 & I3,
    I5 extends Input = I & I2 & I3 & I4,
    I6 extends Input = I & I2 & I3 & I4 & I5,
    I7 extends Input = I & I2 & I3 & I4 & I5 & I6,
    I8 extends Input = I & I2 & I3 & I4 & I5 & I6 & I7,
    I9 extends Input = I & I2 & I3 & I4 & I5 & I6 & I7 & I8,
    I10 extends Input = I & I2 & I3 & I4 & I5 & I6 & I7 & I8 & I9,
    R1 extends HandlerResponse<any> = HandlerResponse<any>,
    R2 extends HandlerResponse<any> = HandlerResponse<any>,
    R3 extends HandlerResponse<any> = HandlerResponse<any>,
    R4 extends HandlerResponse<any> = HandlerResponse<any>,
    R5 extends HandlerResponse<any> = HandlerResponse<any>,
    R6 extends HandlerResponse<any> = HandlerResponse<any>,
    R7 extends HandlerResponse<any> = HandlerResponse<any>,
    R8 extends HandlerResponse<any> = HandlerResponse<any>,
    R9 extends HandlerResponse<any> = HandlerResponse<any>,
    R10 extends HandlerResponse<any> = HandlerResponse<any>,
    E extends Env = RouteEnv<Route>,
    E2 extends Env = RouteEnv<Route>,
    E3 extends Env = RouteEnv<Route>,
    E4 extends Env = RouteEnv<Route>,
    E5 extends Env = RouteEnv<Route>,
    E6 extends Env = RouteEnv<Route>,
    E7 extends Env = RouteEnv<Route>,
    E8 extends Env = RouteEnv<Route>,
    E9 extends Env = RouteEnv<Route>,
  >(
    middleware1: H<E, RoutePath<Route>, I, R1>,
    middleware2: H<E2, RoutePath<Route>, I2, R2>,
    middleware3: H<E3, RoutePath<Route>, I3, R3>,
    middleware4: H<E4, RoutePath<Route>, I4, R4>,
    middleware5: H<E5, RoutePath<Route>, I5, R5>,
    middleware6: H<E6, RoutePath<Route>, I6, R6>,
    middleware7: H<E7, RoutePath<Route>, I7, R7>,
    middleware8: H<E8, RoutePath<Route>, I8, R8>,
    middleware9: H<E9, RoutePath<Route>, I9, R9>,
    handler: Handler<RouteEnv<Route>, RoutePath<Route>, I10, R10>
  ): [
    H<E, RoutePath<Route>, I, R1>,
    H<E2, RoutePath<Route>, I2, R2>,
    H<E3, RoutePath<Route>, I3, R3>,
    H<E4, RoutePath<Route>, I4, R4>,
    H<E5, RoutePath<Route>, I5, R5>,
    H<E6, RoutePath<Route>, I6, R6>,
    H<E7, RoutePath<Route>, I7, R7>,
    H<E8, RoutePath<Route>, I8, R8>,
    H<E9, RoutePath<Route>, I9, R9>,
    Handler<RouteEnv<Route>, RoutePath<Route>, I10, R10>,
  ];
};

const handlerFactory: Factory<ProjectEnv> = createFactory<ProjectEnv>();

export const defineHandler = handlerFactory.createHandlers as DefineHandler;
