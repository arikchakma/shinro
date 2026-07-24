import { defineHandler } from "daroyan/app";

export const GET = defineHandler(
  async (c, next) => {
    c.set("pipelineOrder", ["first"]);
    await next();
  },
  async (c, next) => {
    c.var.pipelineOrder.push("second");
    await next();
  },
  (c) => {
    return c.json(
      {
        order: c.var.pipelineOrder,
      },
      200,
    );
  },
);
