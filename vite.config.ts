import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * Dev-only screenshot sink.
 *
 * A headless browser never fires requestAnimationFrame, so the renderer is
 * otherwise unobservable during automated checks — and "it compiles" is a very
 * different claim from "the planet is on screen". `window.__gs.capture()`
 * renders a frame synchronously and POSTs the PNG here, which writes it to
 * ./screenshots for inspection. Never present in a production build.
 */
function screenshotSink(): Plugin {
  return {
    name: 'globe-snake-screenshot-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__shot', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c as Buffer));
        req.on('end', () => {
          try {
            const { name, data } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const safe = String(name).replace(/[^a-z0-9._-]/gi, '_');
            const body = String(data).replace(/^data:image\/\w+;base64,/, '');
            mkdirSync(resolve(__dirname, 'screenshots'), { recursive: true });
            writeFileSync(resolve(__dirname, 'screenshots', safe), Buffer.from(body, 'base64'));
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, bytes: body.length }));
          } catch (err) {
            res.statusCode = 400;
            res.end(String(err));
          }
        });
      });
    },
  };
}

// GitHub Pages serves project sites from /<repo>/, so the base must match the repo
// name in CI. Locally we serve from root. Set BASE_PATH in the workflow.
const base = process.env.BASE_PATH ?? '/';

export default defineConfig({
  base,
  plugins: [screenshotSink()],
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
