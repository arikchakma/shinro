import { spawn, type ChildProcess } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite-plus";
import { expect, test } from "vite-plus/test";

test("the production entry serves requests and shuts down gracefully", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  let child: ChildProcess | undefined;

  try {
    await build({
      configFile: `${root}/vite.config.ts`,
      logLevel: "silent",
      root,
    });

    const javascript = (await readdir(`${root}/dist`)).filter((file) => /\.(?:c|m)?js$/.test(file));
    expect(javascript).toEqual(["server.mjs"]);

    child = spawn(process.execPath, [`${root}/dist/server.mjs`], {
      cwd: root,
      env: {
        ...process.env,
        PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = collectOutput(child);
    const port = Number((await output.waitFor(/Listening on http:\/\/localhost:(\d+)/))[1]);
    const response = await fetch(`http://127.0.0.1:${port}/v1/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });

    child.kill("SIGTERM");
    await output.waitFor(/HTTP server closed/);
    await expect(exitCode(child)).resolves.toBe(0);
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
    }
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

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
}
