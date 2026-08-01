import { dirname, relative, resolve, sep } from 'node:path';

import { TYPE_DECLARATION_PREFIX } from '../constants.ts';

export function isStrictlyWithin(directory: string, file: string): boolean {
  const path = relative(directory, file);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`);
}

export function routeParameterNames(path: string): string[] {
  return [...path.matchAll(/:([^/{}]+)(?:\{\.\+\})?/g)].map(
    (match) => match[1]
  );
}

export function toProjectPath(root: string, file: string): string {
  return relative(root, file).split(sep).join('/');
}

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
