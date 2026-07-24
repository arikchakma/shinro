import { dirname, relative, resolve, sep } from 'node:path';

export function normalizeBasePath(basePath: string): string {
  if (!basePath.startsWith('/')) {
    throw new Error(
      `[daroyan] basePath must start with "/": ${JSON.stringify(basePath)}`
    );
  }

  // Collapse repeated separators before trimming the trailing one, so a
  // basePath such as "//v1/" cannot register routes under an empty segment.
  const collapsed = basePath.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return collapsed === '' ? '/' : collapsed;
}

export function withBasePath(basePath: string, routePath: string): string {
  if (basePath === '/') {
    return routePath;
  }

  return routePath === '/' ? basePath : `${basePath}${routePath}`;
}

/**
 * Whether `file` sits at or below `directory`. The directory itself counts,
 * which is what path-prefix checks such as "is this inside the generated
 * output" want.
 */
export function isAtOrWithin(directory: string, file: string): boolean {
  const path = relative(directory, file);
  return path !== '..' && !path.startsWith(`..${sep}`);
}

/**
 * Whether `file` sits strictly below `directory`. Used where a directory must
 * not match itself, such as deciding which `_middleware.ts` files wrap a route.
 */
export function isStrictlyWithin(directory: string, file: string): boolean {
  return isAtOrWithin(directory, file) && relative(directory, file) !== '';
}

/**
 * The parameter names a Hono path declares, in order. Matches both `:id` and
 * the catch-all `:path{.+}` form.
 */
export function routeParameterNames(path: string): string[] {
  return [...path.matchAll(/:([^/{}]+)(?:\{\.\+\})?/g)].map(
    (match) => match[1]
  );
}

export function toProjectPath(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

export function generatedImport(outputDirectory: string, file: string): string {
  const path = relative(outputDirectory, file).split(sep).join('/');
  return path.startsWith('.') ? path : `./${path}`;
}

export function companionFile(
  root: string,
  outputDirectory: string,
  routeFile: string
): string {
  const relativeFile = relative(root, routeFile);
  const name =
    relativeFile
      .replace(/\.[^.]+$/, '')
      .split(sep)
      .at(-1) ?? 'index';
  return resolve(
    outputDirectory,
    'types',
    dirname(relativeFile),
    '+types',
    `${name}.d.ts`
  );
}
