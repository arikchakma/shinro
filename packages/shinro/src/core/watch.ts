import type { FSWatcher } from 'node:fs';
import { watch as watchDirectory } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { extname, resolve } from 'node:path';

import type { ResolvedShinroConfig } from '../config.ts';
import { generate } from './generate.ts';
import type { GenerateResult } from './generate.ts';
import type { ShinroLogger } from './logger.ts';
import { affectsRouteTree } from './routes/ignore.ts';

const DEBOUNCE_MS = 30;

/** Recursive `fs.watch` is only documented for macOS and Windows; it misbehaved
 * on Linux for several releases, so everywhere else gets one watcher per
 * directory. */
const SUPPORTS_RECURSIVE =
  process.platform === 'darwin' || process.platform === 'win32';

/**
 * A debounced directory watcher that calls `generate` and reports what changed.
 * It must never spawn or restart a process, install a signal handler, or hold a
 * reference to the user's server: it writes files, and the runner notices.
 */
export async function watch(options: {
  config: ResolvedShinroConfig;
  /** `throw` keeps a cold clone from continuing to a module-not-found for a file
   * Shinro was supposed to write. Later failures are only ever reported. */
  initial?: 'report' | 'throw';
  /** `false` keeps every handle unreferenced, so the process ends when the
   * server does. Only `generate --watch` *is* the process. */
  keepAlive?: boolean;
  logger: ShinroLogger;
  onGenerate?: (result: GenerateResult, changed: string[]) => void;
  /** Defaults to the platform's support. `false` is the watcher-per-directory
   * path, which is what Linux gets. */
  recursive?: boolean;
}): Promise<{ close: () => Promise<void> }> {
  const { config, initial = 'throw', keepAlive = false, logger } = options;
  const recursive = options.recursive ?? SUPPORTS_RECURSIVE;
  const routesDirectory = resolve(config.root, config.routes);
  const watchers = new Map<string, FSWatcher>();
  const triggers = new Set<string>();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let generating = false;
  let queued = false;
  let running: Promise<void> | undefined;

  const run = async (rethrow = false): Promise<void> => {
    if (generating) {
      queued = true;
      return;
    }

    generating = true;
    running = (async () => {
      try {
        const result = await generate({ config, logger });
        const changed = [...triggers];
        triggers.clear();
        options.onGenerate?.(result, changed);
      } catch (error) {
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
    })();

    await running;
  };

  const schedule = (): void => {
    if (closed) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => void run(), DEBOUNCE_MS);
    // Same reason as the watch handles below. Optional call because a test
    // runner's patched `setTimeout` can hand back a handle without `unref`.
    if (!keepAlive) {
      timer.unref?.();
    }
  };

  const onEvent = (directory: string, filename: string | null): void => {
    if (closed) {
      return;
    }

    if (filename === null) {
      schedule();
      return;
    }

    const file = resolve(directory, filename);

    if (extname(file) === '') {
      if (recursive) {
        schedule();
      } else {
        void syncWatchers().then(schedule);
      }
      return;
    }

    if (affectsRouteTree(routesDirectory, file, config.ignoredRouteFiles)) {
      triggers.add(file);
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
        { recursive },
        (_event, filename) => onEvent(directory, filename)
      );
      // A deleted directory raises here, and is an ordinary edit.
      watcher.on('error', () => {
        watchers.delete(directory);
        watcher.close();
      });
      // Load-bearing rather than tidy: a referenced handle keeps the loop alive
      // after the server has drained, so the runner's restart stalls on
      // "waiting for graceful termination" and force-kills.
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

  /** One watcher per live directory: adds the ones that appeared, closes the ones
   * whose directory is gone. Closing is the point — a watcher on a deleted
   * directory never fires again but still holds a handle the OS caps per user. */
  const syncWatchers = async (): Promise<void> => {
    if (recursive || closed) {
      return;
    }

    const entries = await readdir(routesDirectory, {
      recursive: true,
      withFileTypes: true,
    }).catch(() => []);
    const live = new Set([routesDirectory]);

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const directory = resolve(entry.parentPath, entry.name);
        live.add(directory);
        addWatcher(directory);
      }
    }

    for (const [directory, watcher] of watchers) {
      if (!live.has(directory)) {
        watchers.delete(directory);
        watcher.close();
      }
    }
  };

  // Once up front, so the artifacts exist before anything downstream reads them.
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
      // Closed means nothing more will be written, in-flight generation included.
      await running?.catch(() => {});
    },
  };
}
