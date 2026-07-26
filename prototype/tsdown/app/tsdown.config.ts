import { shinro } from 'shinro/tsdown';
import { defineConfig } from 'tsdown';

// The application owns its build. Shinro contributes one thing: it regenerates
// `.shinro` before the bundle is read, so a build can never ship stale routes.
export default defineConfig({
  entry: ['src/server.ts'],
  format: 'esm',
  outDir: 'dist',
  outExtensions: () => ({ js: '.mjs' }),
  platform: 'node',
  target: 'node22',
  unbundle: true,
  plugins: [shinro()],
});
