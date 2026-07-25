import { fileURLToPath } from 'node:url';

import { shinro } from 'shinro';
import { defineConfig } from 'vite-plus';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [
    shinro({
      basePath: '/v1',
    }),
  ],
});
