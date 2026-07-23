import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";

const run = promisify(execFile);

test("public package subpaths expose matching runtime and declaration files", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    exports: Record<string, { import: string; types: string } | string>;
  };

  expect(packageJson.exports).toMatchObject({
    ".": {
      import: "./dist/index.mjs",
      types: "./dist/index.d.mts",
    },
    "./app": {
      import: "./dist/app.mjs",
      types: "./dist/app.d.mts",
    },
    "./entry": {
      import: "./dist/entry.mjs",
      types: "./dist/entry.d.mts",
    },
    "./package.json": "./package.json",
  });
});

test("the packaged entry fallback explains that the Vite plugin is required", async () => {
  await expect(import("../src/entry.ts")).rejects.toThrow(
    /daroyan\/entry[\s\S]*Daroyan Vite plugin[\s\S]*daroyan\(\)/i,
  );
});

test("the package build does not leak the fixture application environment", async () => {
  const packageRoot = new URL("..", import.meta.url);

  await run(new URL("../node_modules/.bin/vp", import.meta.url).pathname, ["pack"], {
    cwd: packageRoot.pathname,
  });

  const declaration = await readFile(new URL("../dist/app.d.mts", import.meta.url), "utf8");
  expect(declaration).not.toContain("tests/fixtures");
  expect(declaration).not.toContain("requestId");
  expect(declaration).toContain("Factory<ProjectEnv");
});
