import { defineConfig } from 'vite';

// Demo app (demo/). The library itself is built with vite.lib.config.ts.
export default defineConfig({
  root: 'demo',
  server: { port: Number(process.env.PORT) || 5173, strictPort: false },
  optimizeDeps: { exclude: ['pdfjs-dist'] },
  build: { target: 'es2022', outDir: '../dist-demo', emptyOutDir: true },
});
