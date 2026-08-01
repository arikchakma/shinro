import { basename, dirname, matchesGlob, relative, sep } from 'node:path';

/** Directories inside `routes/` whose contents are never routes. */
const IGNORED_DIRECTORIES = new Set(['__tests__', '__fixtures__', '+types']);

export function isDirectoryMiddleware(file: string): boolean {
  const name = basename(file);
  return name === '_middleware.ts' || name === '_middleware.js';
}

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
