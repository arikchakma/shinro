/**
 * citty parses the flags it was told about and passes the rest through in
 * `rawArgs`. That is the right default for a CLI that forwards arguments to
 * something else, and the wrong one here: `shinro generate --wtach` would
 * silently generate, and the typo would look like a Shinro bug rather than a
 * typo. Every command runs its raw arguments past this first.
 *
 * `--no-<flag>` is citty's own negation for boolean options, so a command that
 * declares `--watch` accepts `--no-watch` without listing it.
 */
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
