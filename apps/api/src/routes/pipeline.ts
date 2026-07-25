import { defineHandler } from 'shinro/app';

declare module 'hono' {
  interface ContextVariableMap {
    pipelineOrder: string[];
  }
}

export const GET = defineHandler(
  async (c, next) => {
    c.set('pipelineOrder', ['first']);
    await next();
  },
  async (c, next) => {
    c.var.pipelineOrder.push('second');
    await next();
  },
  (c) => {
    return c.json(
      {
        order: c.var.pipelineOrder,
      },
      200
    );
  }
);
