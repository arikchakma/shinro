import { testClient } from "hono/testing";
import { expect, test } from "vite-plus/test";
import app from "daroyan/entry";

const client = testClient(app);

test("a GET route is discovered, assembled, and available to the RPC client", async () => {
  const response = await client.health.$get();

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true });
});

test("the app environment types route handlers without a repeated generic", async () => {
  const response = await client.whoami.$get();

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ requestId: "req_123" });
});

test("multiple directory middleware run once in order at the directory and descendants", async () => {
  for (const path of ["/api", "/api/users"]) {
    const response = await app.request(path);

    expect(response.headers.get("x-middleware-order")).toBe("first,second");
  }
});
