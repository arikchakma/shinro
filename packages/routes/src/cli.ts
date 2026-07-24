#!/usr/bin/env node

import { resolveConfig } from 'vite-plus';

import type { DaroyanApi } from './server/plugin.ts';

const [command] = process.argv.slice(2);

if (command !== 'typegen') {
  console.error('Usage: daroyan typegen');
  process.exitCode = 1;
} else {
  const config = await resolveConfig({}, 'serve');
  const plugin = config.plugins.find(
    (candidate) => candidate.name === 'daroyan'
  );

  if (!plugin) {
    console.error(
      'daroyan typegen could not find daroyan() in the loaded Vite config. Add plugins: [daroyan()] to vite.config.ts.'
    );
    process.exitCode = 1;
  } else {
    // Resolving the config already generates once. Calling the plugin's own API
    // makes that explicit rather than depending on a side effect, and gives the
    // command something concrete to report.
    const result = await (plugin.api as DaroyanApi | undefined)?.generate();

    console.info(
      result
        ? `daroyan typegen wrote ${result.outputDirectory}`
        : 'daroyan typegen completed'
    );
  }
}
