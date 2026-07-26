import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://shinro.dev',
  trailingSlash: 'never',
  output: 'static',

  markdown: {
    shikiConfig: {
      theme: 'github-light',
    },
  },

  vite: {
    plugins: [tailwindcss()],
  },
});
