import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// GitHub Pages serves project sites from /<repo>/, so the base must match the repo
// name in CI. Locally we serve from root. Set BASE_PATH in the workflow.
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  resolve: {
    alias: {
      '@core': resolve(__dirname, 'src/core'),
      '@render': resolve(__dirname, 'src/render'),
      '@game': resolve(__dirname, 'src/game'),
      '@ui': resolve(__dirname, 'src/ui'),
      '@audio': resolve(__dirname, 'src/audio'),
      '@data': resolve(__dirname, 'src/data'),
    },
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: {
        launcher: resolve(__dirname, 'index.html'),
        expedition: resolve(__dirname, 'expedition/index.html'),
        tempest: resolve(__dirname, 'tempest/index.html'),
        terra: resolve(__dirname, 'terra/index.html'),
      },
      output: {
        manualChunks: { three: ['three'] },
      },
    },
  },
  server: { port: 5173, open: false },
  preview: { port: 4173 },
});
