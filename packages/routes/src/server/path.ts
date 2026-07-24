import { dirname, relative, resolve, sep } from 'node:path';

export function normalizeBasePath(basePath: string): string {
  if (!basePath.startsWith('/')) {
    throw new Error(
      `[daroyan] basePath must start with "/": ${JSON.stringify(basePath)}`
    );
  }

  return basePath === '/' ? '/' : basePath.replace(/\/+$/, '');
}

export function withBasePath(basePath: string, routePath: string): string {
  if (basePath === '/') {
    return routePath;
  }

  return routePath === '/' ? basePath : `${basePath}${routePath}`;
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
