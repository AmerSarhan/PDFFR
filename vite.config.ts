import { defineConfig } from 'vite';

// Demo app (demo/). The library itself is built with vite.lib.config.ts.
// DEMO_BASE lets the same build deploy under a sub-path (GitHub Pages).
export default defineConfig({
  root: 'demo',
  base: process.env.DEMO_BASE || '/',
  server: { port: Number(process.env.PORT) || 5173, strictPort: false },
  optimizeDeps: { exclude: ['pdfjs-dist'] },
  build: { target: 'es2022', outDir: '../dist-demo', emptyOutDir: true },
});
