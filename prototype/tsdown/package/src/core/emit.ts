/**
 * Every write goes through here, and here is where the new design earns its
 * keep: the user's runner is watching the filesystem, so an unconditional write
 * is a server restart.
 *
 *   - hash first, skip identical content (manifest.json is the worst offender);
 *   - write to `.tmp` then rename, so no runner ever imports a half-file;
 *   - on failure, leave the previous generation in place rather than emitting
 *     something that crash-loops the runner.
 *
 * Skipping identical content is not an optimisation, it is load-bearing. With
 * `shinro/generate` as a `--import` preload, generation runs on every restart,
 * so an unconditional write bumps the mtime of a file inside the watched tree,
 * which triggers a restart, which regenerates, which writes again. Verified in
 * both directions: unconditional writes restart forever, hash-then-skip settles
 * at exactly one restart per real change.
 *
 * So this is the invariant the whole no-`shinro dev` story rests on, and it
 * deserves a test that asserts mtime is untouched when nothing changed — not
 * just that the bytes match.
 */
export declare function emit(
  outputDirectory: string,
  files: Map<string, string>
): Promise<{ written: string[] }>;
