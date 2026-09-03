import { defineConfig } from 'vite';

// Library build: ESM only, pdf.js and tesseract stay external (peer dependencies).
export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: ['pdfjs-dist', 'tesseract.js'],
    },
  },
});
