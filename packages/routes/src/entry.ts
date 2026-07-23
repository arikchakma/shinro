import { Hono } from "hono";

const app = missingPlugin();

export default app;
export { app };
export const fetch = app.fetch;
export type AppType = typeof app;

function missingPlugin(): Hono {
  throw new Error(
    'Cannot import "daroyan/entry" without the Daroyan Vite plugin. Add daroyan() to your Vite plugins.',
  );
}
