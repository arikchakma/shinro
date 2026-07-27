#!/usr/bin/env node
import { generate } from './cli/generate.ts';
import { init } from './cli/init.ts';

// `shinro generate [--watch] [--check]` is the whole CLI, plus `shinro init` to
// write the boilerplate once. There is no `shinro dev`: `node --watch` plus the
// `shinro/watch` preload covers dev in one process, and anything that spawns the
// runner is the old DevelopmentProcess with a friendlier name.
//
// `typegen` is kept as an undocumented alias for `generate`.
const USAGE = [
  'Usage: shinro <command> [options]',
  '',
  'Commands:',
  '  generate [--watch] [--check]  Write .shinro from the route tree',
  '  init [--dry-run]              Add the imports block, tsconfig, and scripts',
].join('\n');

const [command, ...argv] = process.argv.slice(2);

switch (command) {
  case 'generate':
  case 'typegen': {
    process.exitCode = await generate(argv);
    break;
  }
  case 'init': {
    process.exitCode = await init(argv);
    break;
  }
  case '--help':
  case '-h':
  case undefined: {
    console.info(USAGE);
    break;
  }
  default: {
    console.error(`[shinro] Unknown command "${command}".\n${USAGE}`);
    process.exitCode = 1;
  }
}
