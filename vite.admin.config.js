// Builds the admin page (GitHub Pages) into dist/admin.
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'admin',
  base: './', // served from https://<owner>.github.io/<repo>/
  build: { outDir: '../dist/admin', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 1000 },
  server: { port: 5174 },
});
