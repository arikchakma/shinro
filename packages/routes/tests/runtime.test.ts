import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite-plus";
import { expect, test } from "vite-plus/test";
import { daroyan } from "../src/index.ts";

test("a Node entry owns its listener and graceful shutdown after a one-file build", async () => {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const root = await mkdtemp(`${packageRoot}/.daroyan-node-runtime-`);
  const appHelper = fileURLToPath(new URL("../src/app.ts", import.meta.url));
  let child: ChildProcess | undefined;

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(
    `${root}/app/app.ts`,
    `import { defineApp } from ${JSON.stringify(appHelper)};\nexport default defineApp();\n`,
  );
  await writeFile(
    `${root}/app/routes/health.ts`,
    'export const GET = [(c: any) => c.json({ runtime: "node" })] as const;\n',
  );
  await writeFile(
    `${root}/app/server.ts`,
    [
      'import { serve } from "@hono/node-server";',
      'import app from "daroyan/entry";',
      "",
      "const server = serve({ fetch: app.fetch, port: 0 }, (info) => {",
      "  console.log(`READY:${info.port}`);",
      "});",
      "",
      'process.once("SIGTERM", () => {',
      "  server.close(() => {",
      '    console.log("STOPPED");',
      "  });",
      "});",
      "",
    ].join("\n"),
  );

  try {
    await build({
      configFile: false,
      logLevel: "silent",
      plugins: [daroyan()],
      root,
    });

    const outputFile = `${root}/dist/server.mjs`;
    const bundledSource = await readFile(outputFile, "utf8");
    expect(bundledSource).not.toMatch(
      /^import\s+.+\s+from\s+["'](?:hono(?:\/[^"']*)?|@hono\/node-server)["'];?$/m,
    );

    child = spawn(process.execPath, [outputFile], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = collectOutput(child);
    const port = Number((await output.waitFor(/READY:(\d+)/))[1]);
    const response = await fetch(`http://127.0.0.1:${port}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ runtime: "node" });

    child.kill("SIGTERM");
    await output.waitFor(/STOPPED/);
    await expect(exitCode(child)).resolves.toBe(0);
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await rm(root, { recursive: true });
  }
}, 15_000);

test("a Bun entry owns its listener and graceful shutdown after a one-file build", async () => {
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  const root = await mkdtemp(`${packageRoot}/.daroyan-bun-runtime-`);
  const appHelper = fileURLToPath(new URL("../src/app.ts", import.meta.url));
  let child: ChildProcess | undefined;

  await mkdir(`${root}/app/routes`, { recursive: true });
  await writeFile(
    `${root}/app/app.ts`,
    `import { defineApp } from ${JSON.stringify(appHelper)};\nexport default defineApp();\n`,
  );
  await writeFile(
    `${root}/app/routes/health.ts`,
    'export const GET = [(c: any) => c.json({ runtime: "bun" })] as const;\n',
  );
  await writeFile(
    `${root}/app/server.ts`,
    [
      'import app from "daroyan/entry";',
      "",
      "const server = Bun.serve({ fetch: app.fetch, port: 0 });",
      "console.log(`READY:${server.port}`);",
      "",
      'process.once("SIGTERM", () => {',
      "  void (async () => {",
      "    await server.stop(false);",
      '    console.log("STOPPED");',
      "  })();",
      "});",
      "",
    ].join("\n"),
  );

  try {
    await build({
      configFile: false,
      logLevel: "silent",
      plugins: [daroyan()],
      root,
    });

    child = spawn("bun", [`${root}/dist/server.mjs`], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = collectOutput(child);
    const port = Number((await output.waitFor(/READY:(\d+)/))[1]);
    const response = await fetch(`http://127.0.0.1:${port}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ runtime: "bun" });

    child.kill("SIGTERM");
    await output.waitFor(/STOPPED/);
    await expect(exitCode(child)).resolves.toBe(0);
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await rm(root, { recursive: true });
  }
}, 15_000);

function collectOutput(child: ChildProcess): {
  waitFor: (pattern: RegExp) => Promise<RegExpMatchArray>;
} {
  let output = "";
  const waiters = new Set<() => void>();
  const onData = (chunk: Buffer) => {
    output += chunk.toString();
    for (const notify of waiters) {
      notify();
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  return {
    waitFor(pattern) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`Timed out waiting for ${pattern} in:\n${output}`));
        }, 5_000);
        const check = () => {
          const match = output.match(pattern);
          if (!match) {
            return;
          }
          clearTimeout(timeout);
          waiters.delete(check);
          resolve(match);
        };
        waiters.add(check);
        check();
      });
    },
  };
}

function exitCode(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve) => {
    child.once("close", resolve);
  });
}
