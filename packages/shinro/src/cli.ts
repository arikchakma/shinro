#!/usr/bin/env node
import { defineCommand, renderUsage, runMain } from 'citty';

import { generate, typegen } from './cli/generate.ts';
import { init } from './cli/init.ts';
import { createReporter } from './cli/report.ts';

// `typegen` is a hidden command rather than a citty alias, which would list it
// in `--help`.
const main = defineCommand({
  meta: {
    description:
      'Opinionated file-based routing for Hono with end-to-end type safety.',
    name: 'shinro',
  },
  subCommands: { generate, init, typegen },
});

// citty reports an unknown command unquoted, after the usage text.
const COMMANDS = new Set(['generate', 'init', 'typegen']);
const [first] = process.argv.slice(2);

if (first !== undefined && !first.startsWith('-') && !COMMANDS.has(first)) {
  createReporter().error(`[shinro] Unknown command "${first}".`);
  console.error(`\n${await renderUsage(main)}`);
  process.exitCode = 1;
} else {
  await runMain(main);
}
