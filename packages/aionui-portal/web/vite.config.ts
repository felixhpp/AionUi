import { resolve } from 'node:path';

import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  root: __dirname,
  build: {
    outDir: resolve(__dirname, '../dist/admin'),
    emptyOutDir: true,
  },
  server: {
    port: 5178,
    proxy: {
      '/api': 'http://127.0.0.1:8085',
    },
  },
});
