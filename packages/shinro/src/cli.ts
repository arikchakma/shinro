#!/usr/bin/env node
import { defineCommand, renderUsage, runMain } from 'citty';

import { generate, typegen } from './cli/generate.ts';
import { init } from './cli/init.ts';
import { createReporter } from './cli/report.ts';

// `shinro generate [--watch] [--check]` is the whole CLI, plus `shinro init` to
// write the boilerplate once. There is no `shinro dev`: `node --watch` plus the
// `shinro/watch` preload covers dev in one process, and anything that spawned the
// runner would owe you a supervisor's signal handling.
//
// `typegen` is registered as a hidden command rather than a citty alias, because
// an alias would list it in `--help` — and the point of keeping it is that old
// scripts run, not that anyone writes it again.
const main = defineCommand({
  meta: {
    description:
      'Opinionated file-based routing for Hono with end-to-end type safety.',
    name: 'shinro',
  },
  subCommands: { generate, init, typegen },
});

// citty reports an unknown command after printing usage, unquoted. The quotes
// are the difference between "we did not recognise this word" and a sentence
// that happens to contain the word, so the check lives here instead.
const COMMANDS = new Set(['generate', 'init', 'typegen']);
const [first] = process.argv.slice(2);

if (first !== undefined && !first.startsWith('-') && !COMMANDS.has(first)) {
  createReporter().error(`[shinro] Unknown command "${first}".`);
  console.error(`\n${await renderUsage(main)}`);
  process.exitCode = 1;
} else {
  await runMain(main);
}
