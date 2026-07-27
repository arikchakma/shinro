#!/usr/bin/env node
// `shinro generate [--watch] [--check]` is the whole CLI, plus `shinro init` to
// write the `imports` block once. There is no `shinro dev`: `node --watch` plus
// the `shinro/generate` preload covers dev in one process, and anything that
// spawns the runner is the old DevelopmentProcess with a friendlier name.
//
// `typegen` is kept as an undocumented alias for `generate`.
export {};
