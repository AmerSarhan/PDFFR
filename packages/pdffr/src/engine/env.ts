import type * as Pdfjs from 'pdfjs-dist';

/** The minimum a canvas must offer: browsers, OffscreenCanvas and @napi-rs/canvas all qualify. */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: '2d', opts?: unknown): any;
}

/**
 * Everything the engine needs from its host runtime. `pdffr` (browser) and `pdffr/node`
 * install one of these before any page is touched; the engine itself never imports
 * pdf.js directly, so the right build (modern vs legacy) is the entry point's decision.
 */
export interface Env {
  pdfjs: typeof Pdfjs;
  createCanvas(width: number, height: number): CanvasLike;
  /** What tesseract should be handed for a canvas in this runtime (the canvas itself, or a PNG buffer). */
  toOcrImage(canvas: CanvasLike): unknown;
  /** Free a canvas's backing store early. */
  release(canvas: CanvasLike): void;
  /** Extra options for tesseract's `createWorker` (cache path, worker path…). */
  ocrWorkerOptions?: Record<string, unknown>;
  /** Where pdf.js finds its standard 14 fonts (needed to resolve Symbol/ZapfDingbats glyphs). */
  standardFontDataUrl?: string;
}

let current: Env | null = null;

export function setEnv(env: Env) {
  current = env;
}

export function getEnv(): Env {
  if (!current) {
    throw new Error(
      'pdffr: no runtime configured — import from "pdffr" in a browser or "pdffr/node" in Node.js',
    );
  }
  return current;
}
