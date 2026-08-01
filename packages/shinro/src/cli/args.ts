export function unknownOptions(rawArgs: string[], known: string[]): string[] {
  const accepted = new Set([
    '-h',
    '--help',
    ...known.flatMap((flag) => [flag, `--no-${flag.replace(/^--/, '')}`]),
  ]);

  return rawArgs.filter(
    (argument) =>
      argument.startsWith('-') &&
      // `--flag=value` is the same flag as `--flag`.
      !accepted.has(argument.split('=')[0])
  );
}
