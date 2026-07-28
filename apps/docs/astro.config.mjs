import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

import { createCodeTitleTransformer } from './src/lib/shiki.ts';

export default defineConfig({
  site: 'https://shinro.dev',
  trailingSlash: 'never',
  output: 'static',

  markdown: {
    shikiConfig: {
      theme: 'github-light',
      transformers: [createCodeTitleTransformer()],
    },
  },

  vite: {
    plugins: [tailwindcss()],
  },
});
