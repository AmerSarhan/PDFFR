/** Node entry: legacy pdf.js build, @napi-rs/canvas, tesseract fed PNG buffers. */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setEnv } from './engine/env';
import { setPdfWorkerSrc } from './engine/pdf';
import { decompile, type DecompileOptions, type DecompileResult } from './core';

const require = createRequire(import.meta.url);
const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
setEnv({
  pdfjs: pdfjs as any,
  createCanvas: (w, h) => createCanvas(w, h) as any,
  toOcrImage: (c) => (c as any).toBuffer('image/png'),
  release: () => {},
  ocrWorkerOptions: { cachePath: join(tmpdir(), 'pdffr-tessdata') },
  standardFontDataUrl: join(dirname(workerPath), '..', '..', 'standard_fonts') + '/',
});
setPdfWorkerSrc(pathToFileURL(workerPath).href);

export * from './core';

/** Decompile a PDF file on disk. */
export async function decompileFile(path: string, opts: DecompileOptions = {}): Promise<DecompileResult> {
  const buf = await readFile(path);
  return decompile(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), opts);
}
