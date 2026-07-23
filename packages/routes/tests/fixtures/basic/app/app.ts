import { defineApp } from "daroyan/app";

export type AppEnv = {
  Variables: {
    requestId: string;
  };
};

const app = defineApp<AppEnv>().get("/manual", (c) => {
  return c.json({ manual: true as const });
});

app.use("*", async (c, next) => {
  c.set("requestId", "req_123");
  await next();
});

export default app;
