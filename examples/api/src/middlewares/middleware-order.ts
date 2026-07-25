import { createMiddleware } from 'hono/factory';

declare module 'hono' {
  interface ContextVariableMap {
    middlewareOrder: string[];
  }
}

export const beginMiddlewareChain = createMiddleware(async (c, next) => {
  c.set('middlewareOrder', ['root:first']);
  await next();
  c.header('x-middleware-order', c.var.middlewareOrder.join(','));
});

export const continueMiddlewareChain = createMiddleware(async (c, next) => {
  c.var.middlewareOrder.push('root:second');
  await next();
});
