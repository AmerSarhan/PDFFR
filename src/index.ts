/** Browser entry: modern pdf.js build, DOM canvases, tesseract fed canvases directly. */
import * as pdfjs from 'pdfjs-dist';
import { setEnv } from './engine/env';

setEnv({
  pdfjs,
  createCanvas(width, height) {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  },
  toOcrImage: (c) => c,
  release(c) {
    c.width = 0;
    c.height = 0;
  },
});

export * from './core';
