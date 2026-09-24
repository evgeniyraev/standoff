// Builds the kiosk renderers (game, settings, remote) into dist/renderer.
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const page = (name) => resolve(import.meta.dirname, 'src/renderer', name, 'index.html');

export default defineConfig({
  root: 'src/renderer',
  base: './', // loaded from file:// in the packaged app
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    target: 'esnext',
    chunkSizeWarningLimit: 1000,
    rollupOptions: { input: { game: page('game'), settings: page('settings'), remote: page('remote') } },
  },
  server: { port: 5173, strictPort: true },
});
