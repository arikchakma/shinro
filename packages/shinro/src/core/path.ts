import { dirname, relative, resolve, sep } from 'node:path';

import { TYPE_DECLARATION_PREFIX } from '../constants.ts';

/** Whether `file` sits at or below `directory`. The directory itself counts. */
function isAtOrWithin(directory: string, file: string): boolean {
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

/**
 * A path as the user would write it. Forward slashes on every platform, because
 * this reaches both diagnostics and the manifest, and a manifest whose contents
 * depend on the OS turns `--check` into CI flake on the first Windows runner.
 */
export function toProjectPath(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

/**
 * How the generated router refers to a source file: a relative specifier with
 * its `.ts` extension intact. Not a bare specifier and not an alias — a real
 * path on disk is the one thing every runner resolves without configuration.
 */
export function generatedSpecifier(
  outputDirectory: string,
  file: string
): string {
  return toRelativeSpecifier(
    relative(outputDirectory, file).split(sep).join('/')
  );
}

/**
 * Prefixes `./` unless the path already navigates. Testing for a leading dot is
 * not enough — `.shinro/routes.ts` starts with one and is still a bare
 * specifier.
 */
export function toRelativeSpecifier(path: string): string {
  return /^\.{1,2}\//.test(path) ? path : `./${path}`;
}

/** Where a route file's generated `+types` declaration is written. */
export function getTypeDeclarationPath(
  root: string,
  routesDirectory: string,
  outputDirectory: string,
  sourceFile: string
): string {
  const path = relative(routesDirectory, sourceFile).split(sep).join('/');
  const resolved = resolve(
    dirname(sourceFile),
    `./${TYPE_DECLARATION_PREFIX}/${path.replace(/\.[^.]+$/, '.ts')}`
  );
  return resolve(
    outputDirectory,
    'types',
    relative(root, resolved).replace(/\.ts$/, '.d.ts')
  );
}
