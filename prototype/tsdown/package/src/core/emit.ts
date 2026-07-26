/**
 * Every write goes through here, and here is where the new design earns its
 * keep: the user's runner is watching the filesystem, so an unconditional
 * write is a server restart.
 *
 *   - hash first, skip identical content (manifest.json is the worst offender);
 *   - write to `.tmp` then rename, so no runner ever imports a half-file;
 *   - on failure, leave the previous generation in place rather than emitting
 *     something that crash-loops the runner.
 */
export declare function emit(
  outputDirectory: string,
  files: Map<string, string>
): Promise<{ written: string[] }>;
