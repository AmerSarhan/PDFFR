import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // pdf.js requires its legacy build outside the browser
    alias: [{ find: /^pdfjs-dist$/, replacement: 'pdfjs-dist/legacy/build/pdf.mjs' }],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
