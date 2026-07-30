import { basename, dirname, matchesGlob, relative, sep } from 'node:path';

/** Directories inside `routes/` whose contents are never routes. */
const IGNORED_DIRECTORIES = new Set(['__tests__', '__fixtures__', '+types']);

export function isDirectoryMiddleware(file: string): boolean {
  const name = basename(file);
  return name === '_middleware.ts' || name === '_middleware.js';
}

/**
 * Whether a file is eligible to become a route, by name alone.
 *
 * A leading `-` excludes the file so the schemas, queries, and fixtures a route
 * needs can sit beside it. `[-]name.ts` still serves `/-name`, because the escape
 * puts `[` at the front of the name that this reads.
 */
export function isRouteCandidate(
  routesDirectory: string,
  file: string
): boolean {
  const name = basename(file);
  const supportedExtension = name.endsWith('.ts') || name.endsWith('.js');

  return (
    supportedExtension &&
    !name.startsWith('_') &&
    !name.startsWith('.') &&
    !name.startsWith('-') &&
    !name.endsWith('.d.ts') &&
    !/\.(?:test|spec)\./.test(name) &&
    !isInIgnoredDirectory(routesDirectory, file)
  );
}

/** Whether a file matches the project's `ignoredRouteFiles` globs. */
export function matchesIgnorePattern(
  routesDirectory: string,
  file: string,
  patterns: string[] | undefined
): boolean {
  if (!patterns || patterns.length === 0) {
    return false;
  }

  const routeRelativeFile = relative(routesDirectory, file)
    .split(sep)
    .join('/');

  return patterns.some((pattern) => matchesGlob(routeRelativeFile, pattern));
}

/**
 * Whether a file inside the routes directory can change the route tree, so a
 * watcher can skip regenerating for READMEs, fixtures, snapshots, and the other
 * files that live alongside routes.
 */
export function affectsRouteTree(
  routesDirectory: string,
  file: string,
  ignoredRouteFiles: string[] | undefined
): boolean {
  if (matchesIgnorePattern(routesDirectory, file, ignoredRouteFiles)) {
    return false;
  }

  return isDirectoryMiddleware(file) || isRouteCandidate(routesDirectory, file);
}

/**
 * Whether a file sits under a directory the scan never descends into. Applies to
 * directory middleware too, which `isRouteCandidate` rejects on its own name.
 */
export function isInIgnoredDirectory(
  routesDirectory: string,
  file: string
): boolean {
  const segments = relative(routesDirectory, dirname(file)).split(sep);
  return segments.some(
    (segment) =>
      segment.startsWith('.') ||
      segment.startsWith('-') ||
      IGNORED_DIRECTORIES.has(segment)
  );
}
