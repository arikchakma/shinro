#!/usr/bin/env node

import { resolveConfig } from 'vite-plus';

const [command] = process.argv.slice(2);

if (command !== 'typegen') {
  console.error('Usage: daroyan typegen');
  process.exitCode = 1;
} else {
  const config = await resolveConfig({}, 'serve');

  if (!config.plugins.some((plugin) => plugin.name === 'daroyan')) {
    console.error(
      'daroyan typegen could not find daroyan() in the loaded Vite config. Add plugins: [daroyan()] to vite.config.ts.'
    );
    process.exitCode = 1;
  }
}
