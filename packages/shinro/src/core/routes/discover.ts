import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import type { Method } from '../../constants.ts';
import { HTTP_METHODS } from '../../constants.ts';
import { isStrictlyWithin, routeParameterNames } from '../path.ts';
import {
  assertRouteExports,
  readMiddlewareCount,
  readRouteExports,
} from './exports.ts';
import {
  isDirectoryMiddleware,
  isInIgnoredDirectory,
  isRouteCandidate,
  matchesIgnorePattern,
} from './ignore.ts';
import { toRoutePath } from './url.ts';

export type Route = {
  file: string;
  handlerCounts: Partial<Record<Method, number | null>>;
  kind: 'methods' | 'sub-router';
  methods: Method[];
  /** Every `_middleware.ts` wrapping this route, ordered root-first. */
  middleware: string[];
  path: string;
};

export type DirectoryMiddleware = {
  file: string;
  /** Middleware tuple length, or `null` when a spread makes it unknown. */
  handlerCount: number | null;
  path: string;
};

export type RouteTree = {
  middleware: DirectoryMiddleware[];
  routes: Route[];
};

export async function discoverRoutes(
  routesDirectory: string,
  options: {
    ignoredRouteFiles?: string[];
    warn?: (message: string) => void;
  } = {}
): Promise<RouteTree> {
  const entries = await readEntries(routesDirectory);
  const isIgnored = (file: string): boolean =>
    matchesIgnorePattern(routesDirectory, file, options.ignoredRouteFiles);
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort((left, right) => left.localeCompare(right));

  const middlewareFiles = files.filter(
    (file) =>
      isDirectoryMiddleware(file) &&
      !isInIgnoredDirectory(routesDirectory, file) &&
      !isIgnored(file)
  );
  const candidates = files.filter(
    (file) => isRouteCandidate(routesDirectory, file) && !isIgnored(file)
  );

  const middlewareCounts = await settleInOrder(
    middlewareFiles.map(readMiddlewareCount)
  );
  const parsed = await settleInOrder(candidates.map(readRouteExports));
  const routes: Route[] = [];

  for (const [index, file] of candidates.entries()) {
    const routeExports = parsed[index];
    const path = toRoutePath(routesDirectory, file);

    assertRouteExports(file, routeExports);

    if (routeExports.methods.length === 0 && !routeExports.hasDefault) {
      options.warn?.(
        `[shinro] Ignoring ${file}: the route file has no supported method export. Export one of ${HTTP_METHODS.join(
          ', '
        )}.`
      );
      continue;
    }

    const filenameParameters = routeParameterNames(path);
    for (const schemaParameters of routeExports.parameterSchemas) {
      // Order-insensitive: a schema is free to declare its keys in any order.
      if (
        [...filenameParameters].sort().join() !==
        [...schemaParameters].sort().join()
      ) {
        options.warn?.(
          `[shinro] ${file} has a parameter schema declaring [${schemaParameters.join(
            ', '
          )}], but its filename path ${path} declares [${filenameParameters.join(', ')}].`
        );
      }
    }

    routes.push({
      file,
      handlerCounts: routeExports.handlerCounts,
      kind: routeExports.hasDefault ? 'sub-router' : 'methods',
      methods: routeExports.methods,
      middleware: middlewareChain(middlewareFiles, file),
      path,
    });
  }

  return {
    middleware: middlewareFiles.map((file, index) => ({
      file,
      handlerCount: middlewareCounts[index],
      path: toRoutePath(
        routesDirectory,
        resolve(dirname(file), 'index.ts'),
        file
      ),
    })),
    routes: routes.sort(compareRoutes),
  };
}

async function readEntries(routesDirectory: string): Promise<Dirent[]> {
  try {
    return await readdir(routesDirectory, {
      recursive: true,
      withFileTypes: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `[shinro] Routes directory not found: ${routesDirectory}\nCreate it or configure "routes" in shinro.config.json.`,
        { cause: error }
      );
    }
    throw error;
  }
}

function middlewareChain(middlewareFiles: string[], file: string): string[] {
  return middlewareFiles
    .filter((middlewareFile) => isStrictlyWithin(dirname(middlewareFile), file))
    .sort(
      (left, right) =>
        left.split(sep).length - right.split(sep).length ||
        left.localeCompare(right)
    );
}

async function settleInOrder<T>(work: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(work);
  const values: T[] = [];

  for (const result of settled) {
    if (result.status === 'rejected') {
      throw result.reason;
    }
    values.push(result.value);
  }

  return values;
}

/** Static segments before dynamic before catch-all, which is Hono's own priority. */
function compareRoutes(left: Route, right: Route): number {
  const leftSegments = left.path.split('/').filter(Boolean);
  const rightSegments = right.path.split('/').filter(Boolean);

  for (
    let index = 0;
    index < Math.max(leftSegments.length, rightSegments.length);
    index += 1
  ) {
    const priorityDifference =
      segmentPriority(leftSegments[index]) -
      segmentPriority(rightSegments[index]);

    if (priorityDifference !== 0) {
      return priorityDifference;
    }
  }

  return left.path.localeCompare(right.path);
}

function segmentPriority(segment: string | undefined): number {
  if (segment === undefined) {
    return -1;
  }
  if (segment.endsWith('{.+}')) {
    return 2;
  }
  if (segment.startsWith(':')) {
    return 1;
  }
  return 0;
}
