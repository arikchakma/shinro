#!/usr/bin/env node

import { resolveConfig } from 'vite';

import type { ShinroApi } from './server/plugin.ts';

const [command] = process.argv.slice(2);

if (command !== 'typegen') {
  console.error('Usage: shinro typegen');
  process.exitCode = 1;
} else {
  const config = await resolveConfig({}, 'serve');
  const plugin = config.plugins.find(
    (candidate) => candidate.name === 'shinro'
  );

  if (!plugin) {
    console.error(
      'shinro typegen could not find shinro() in the loaded Vite config. Add plugins: [shinro()] to vite.config.ts.'
    );
    process.exitCode = 1;
  } else {
    // Resolving the config already generates once. Calling the plugin's own API
    // makes that explicit rather than depending on a side effect, and gives the
    // command something concrete to report.
    const result = await (plugin.api as ShinroApi | undefined)?.generate();

    console.info(
      result
        ? `shinro typegen wrote ${result.outputDirectory}`
        : 'shinro typegen completed'
    );
  }
}
