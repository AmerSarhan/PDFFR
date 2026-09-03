import { defineConfig } from 'vite';

// Library build: ESM only; pdf.js, tesseract and the Node canvas stay external (peer dependencies).
export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: { index: 'src/index.ts', node: 'src/node.ts' },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      external: [/^pdfjs-dist/, 'tesseract.js', '@napi-rs/canvas', /^node:/],
      output: { chunkFileNames: 'chunks/[name]-[hash].js' },
    },
  },
});
