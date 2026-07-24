import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite-plus';

import { daroyan } from '../../packages/routes/src/index.ts';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [
    daroyan({
      basePath: '/v1',
    }),
  ],
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
