import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';

import type { Logger } from 'vite';

const RUNNER_SOURCE = `
import { createServer, createServerModuleRunner } from "vite";

const server = await createServer({
  configFile: process.env.SHINRO_DEV_CONFIG || undefined,
  root: process.env.SHINRO_DEV_ROOT,
  server: {
    hmr: false,
    middlewareMode: true,
  },
});
const runner = createServerModuleRunner(server.environments.ssr);

try {
  await runner.import(process.env.SHINRO_DEV_ENTRY);
} finally {
  await server.close();
}
`;

export class DevelopmentProcess {
  readonly #configFile: string | undefined;
  readonly #entry: string;
  readonly #logger: Logger;
  readonly #root: string;
  #child: ChildProcess | undefined;
  #closed = false;
  #pending = Promise.resolve();
  #restartTimer: NodeJS.Timeout | undefined;

  constructor(options: {
    configFile: string | undefined;
    entry: string;
    logger: Logger;
    root: string;
  }) {
    this.#configFile = options.configFile;
    this.#entry = options.entry;
    this.#logger = options.logger;
    this.#root = options.root;
  }

  start(): void {
    this.#enqueueRestart();
  }

  restart(): void {
    clearTimeout(this.#restartTimer);
    this.#restartTimer = setTimeout(() => this.#enqueueRestart(), 50);
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#restartTimer);
    await this.#pending;
    await this.#terminateChild();
  }

  #enqueueRestart(): void {
    this.#pending = this.#pending
      .then(async () => {
        await this.#terminateChild();
        if (!this.#closed) {
          this.#spawnChild();
        }
      })
      .catch((error: unknown) => {
        this.#logger.error(
          `[shinro] Failed to restart the development server entry: ${
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error)
          }`
        );
      });
  }

  #spawnChild(): void {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '--eval', RUNNER_SOURCE],
      {
        cwd: this.#root,
        env: {
          ...process.env,
          SHINRO_DEV_CHILD: '1',
          SHINRO_DEV_CONFIG: this.#configFile ?? '',
          SHINRO_DEV_ENTRY: this.#entry,
          SHINRO_DEV_ROOT: this.#root,
        },
        stdio: 'inherit',
      }
    );
    this.#child = child;
    child.once('exit', (code, signal) => {
      if (this.#child === child) {
        this.#child = undefined;
      }
      if (!this.#closed && code !== 0) {
        this.#logger.error(
          `[shinro] Development server entry exited unexpectedly (${signal ?? `code ${code}`}).`
        );
      }
    });
  }

  async #terminateChild(): Promise<void> {
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    child.kill('SIGTERM');
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, 10_000);
    try {
      await once(child, 'exit');
    } finally {
      clearTimeout(forceTimer);
    }
  }
}
