import type { FSWatcher } from 'node:fs';
import { watch as watchDirectory } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

import type { ResolvedShinroConfig } from '../config.ts';
import { generate } from './generate.ts';
import type { GenerateResult } from './generate.ts';
import type { ShinroLogger } from './logger.ts';
import { affectsRouteTree } from './scanner.ts';

const DEBOUNCE_MS = 30;

/**
 * Recursive `fs.watch` is documented as supported on macOS and Windows. It
 * landed on Linux in Node 20.13 and misbehaved for several releases after, so
 * everywhere else gets one watcher per directory. Owning the watcher is what
 * makes that fallback a detail of this file rather than a platform caveat in the
 * documentation.
 */
const SUPPORTS_RECURSIVE =
  process.platform === 'darwin' || process.platform === 'win32';

/**
 * A debounced directory watcher that calls `generate` and reports what changed.
 *
 * It watches the routes directory rather than a module graph, because that is
 * the one thing a graph watcher structurally cannot do: nothing imports a
 * brand-new route file, so nothing in the graph points at it. That gap is why
 * `tsdown --watch` and bare `node --watch` both miss new routes — and why this
 * watcher closes it by writing to `routes.ts`, which every graph watcher already
 * sees.
 *
 * What it does not do, and must never do: spawn a process, restart a process,
 * install a signal handler, or hold a reference to the user's server. It writes
 * files. The runner notices. That is the whole contract, and it is what keeps
 * `shinro dev` from being necessary.
 */
export async function watch(options: {
  config: ResolvedShinroConfig;
  /**
   * What to do when the very first generation fails. `throw` is the default
   * because a caller that has not generated yet — a `--import` preload on a cold
   * clone — must not let the runner continue to a module-not-found for a file
   * Shinro was supposed to write. `report` suits a long-running watcher, where
   * the user is about to fix the file and wants the watcher still running when
   * they do.
   *
   * Failures after the first are always reported, never thrown: a half-saved
   * route file is a normal state in a dev loop.
   */
  initial?: 'report' | 'throw';
  /**
   * Whether the watcher may hold the event loop open. `false` — the default, and
   * the only right answer inside someone's server process — keeps every handle
   * unreferenced, so the process ends when the server does. `shinro generate
   * --watch` is the exception: there the watcher *is* the process.
   */
  keepAlive?: boolean;
  logger: ShinroLogger;
  onGenerate?: (result: GenerateResult) => void;
}): Promise<{ close: () => Promise<void> }> {
  const { config, initial = 'throw', keepAlive = false, logger } = options;
  const routesDirectory = resolve(config.root, config.routes);
  const watchers = new Map<string, FSWatcher>();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let generating = false;
  let queued = false;

  const run = async (rethrow = false): Promise<void> => {
    if (generating) {
      queued = true;
      return;
    }

    generating = true;
    try {
      const result = await generate({ config, logger });
      if (result.written.length > 0 || result.removed.length > 0) {
        options.onGenerate?.(result);
      }
    } catch (error) {
      // A route conflict or a syntax error mid-edit is a normal state in a dev
      // loop: the previous generation is still on disk, and taking down the
      // process over a typo is worse than serving a stale route for two seconds.
      // The first generation is the exception — see `initial`.
      if (rethrow) {
        throw error;
      }
      logger.error(error instanceof Error ? error.message : String(error));
    } finally {
      generating = false;
      if (queued && !closed) {
        queued = false;
        schedule();
      }
    }
  };

  const schedule = (): void => {
    if (closed) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => void run(), DEBOUNCE_MS);
    // Same reason as the watch handles: a pending debounce must not hold the
    // loop open while the server is shutting down. Optional because a test
    // runner's patched `setTimeout` can hand back a plain handle with no
    // `unref` — and a throw here would be swallowed inside a watch callback,
    // which is a very quiet way to lose a dev loop.
    if (!keepAlive) {
      timer.unref?.();
    }
  };

  const onEvent = (directory: string, filename: string | null): void => {
    if (closed) {
      return;
    }

    // A null filename says only that something happened. Regenerating is cheap
    // when nothing changed — `emit` writes nothing — so the ambiguous case
    // resolves in favour of correctness.
    if (filename === null) {
      schedule();
      return;
    }

    const file = resolve(directory, filename);
    const isDirectoryShaped = extname(file) === '';

    if (isDirectoryShaped && !SUPPORTS_RECURSIVE) {
      void syncWatchers().then(schedule);
      return;
    }

    if (
      isDirectoryShaped ||
      affectsRouteTree(routesDirectory, file, config.ignoredRouteFiles)
    ) {
      schedule();
    }
  };

  const addWatcher = (directory: string): void => {
    if (closed || watchers.has(directory)) {
      return;
    }

    try {
      const watcher = watchDirectory(
        directory,
        { recursive: SUPPORTS_RECURSIVE },
        (_event, filename) => onEvent(directory, filename)
      );
      // A deleted directory raises here rather than rejecting anything, and it
      // is an ordinary edit — the route tree just lost a subtree.
      watcher.on('error', () => {
        watchers.delete(directory);
        watcher.close();
      });
      // Unreferenced by default, and this is load-bearing rather than tidy. The
      // runner restarts by sending SIGTERM and waiting for the process to end on
      // its own; a referenced watch handle keeps the event loop alive after the
      // user's server has drained, so the restart stalls on "waiting for graceful
      // termination" and gets force-killed. Shinro's watcher must never be the
      // reason a process outlives its server.
      if (!keepAlive) {
        watcher.unref();
      }
      watchers.set(directory, watcher);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  };

  const syncWatchers = async (): Promise<void> => {
    if (SUPPORTS_RECURSIVE || closed) {
      return;
    }

    const entries = await readdir(routesDirectory, {
      recursive: true,
      withFileTypes: true,
    }).catch(() => []);

    for (const entry of entries) {
      if (entry.isDirectory()) {
        addWatcher(resolve(entry.parentPath, entry.name));
      }
    }
  };

  // Generate once, synchronously with respect to the caller, so the artifacts
  // exist before anything downstream reads them. Watching starts after.
  await run(initial === 'throw');
  addWatcher(routesDirectory);
  await syncWatchers();

  return {
    close: async () => {
      closed = true;
      clearTimeout(timer);
      for (const watcher of watchers.values()) {
        watcher.close();
      }
      watchers.clear();
    },
  };
}
