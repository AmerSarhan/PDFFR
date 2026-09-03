import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { Region, Run } from './types';

export type { PDFDocumentProxy, PDFPageProxy };

/** Point pdf.js at its worker script. Bundled apps usually pass `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href`. */
export function setPdfWorkerSrc(url: string) {
  pdfjs.GlobalWorkerOptions.workerSrc = url;
}

function ensureWorker() {
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    setPdfWorkerSrc(`https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`);
  }
}

export function loadDoc(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  ensureWorker();
  return pdfjs.getDocument({ data }).promise;
}

export interface NativeExtract {
  runs: Run[];
  chars: number;
  /** fraction of page area covered by glyph boxes */
  coverage: number;
  width: number;
  height: number;
  rotatedSkipped: number;
}

const IMAGE_OPS = new Set<number>(
  [
    (pdfjs.OPS as any).paintImageXObject,
    (pdfjs.OPS as any).paintImageXObjectRepeat,
    (pdfjs.OPS as any).paintInlineImageXObject,
    (pdfjs.OPS as any).paintInlineImageXObjectGroup,
    (pdfjs.OPS as any).paintImageMaskXObject,
    (pdfjs.OPS as any).paintImageMaskXObjectGroup,
    (pdfjs.OPS as any).paintImageMaskXObjectRepeat,
    (pdfjs.OPS as any).paintJpegXObject,
  ].filter((n) => typeof n === 'number'),
);

/**
 * Where are the bitmaps? Walk the operator list tracking the CTM (save/restore/transform and
 * form XObjects) so every image paint resolves to an exact page rectangle. The PDF already
 * knows this; no pixel heuristics needed.
 */
export async function pageImages(page: PDFPageProxy): Promise<{ count: number; rects: Region[] }> {
  const ops = await page.getOperatorList();
  const OPS: any = pdfjs.OPS;
  const vp = page.getViewport({ scale: 1 });
  // m1 × m2 in PDF row-vector convention (same as canvas ctx.transform)
  const mul = (m1: number[], m2: number[]): number[] => [
    m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
  const apply = (x: number, y: number, m: number[]) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
  const isMatrix = (a: unknown): a is number[] => Array.isArray(a) && a.length >= 6 && a.every((v) => typeof v === 'number');
  let ctm: number[] = Array.from(vp.transform as number[]);
  const stack: number[][] = [];
  const rects: Region[] = [];
  let count = 0;
  const unitRect = () => {
    const pts = [apply(0, 0, ctm), apply(1, 0, ctm), apply(0, 1, ctm), apply(1, 1, ctm)];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x = Math.max(0, Math.min(...xs));
    const y = Math.max(0, Math.min(...ys));
    return { x, y, w: Math.min(vp.width, Math.max(...xs)) - x, h: Math.min(vp.height, Math.max(...ys)) - y };
  };
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args: any = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm.slice());
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) { if (isMatrix(args)) ctm = mul(ctm, args); }
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm.slice());
      if (args && isMatrix(args[0])) ctm = mul(ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (IMAGE_OPS.has(fn)) {
      count++;
      if (fn === OPS.paintImageXObjectRepeat || fn === OPS.paintImageMaskXObjectRepeat) continue;
      const r = unitRect();
      if (r.w > 4 && r.h > 4) rects.push(r);
    }
  }
  return { count, rects };
}

interface FontMeta { bold: boolean; italic: boolean; name: string }

/** Lower the page's native text layer to positioned runs. Zero rasterization. */
export async function extractNative(page: PDFPageProxy): Promise<NativeExtract> {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const fontCache = new Map<string, FontMeta>();

  const meta = (fontName: string): FontMeta => {
    const hit = fontCache.get(fontName);
    if (hit) return hit;
    let bold = false;
    let italic = false;
    let name = tc.styles[fontName]?.fontFamily || '';
    try {
      const f: any = page.commonObjs.has(fontName) ? page.commonObjs.get(fontName) : null;
      if (f) {
        bold = !!(f.bold || f.black);
        italic = !!f.italic;
        const n = String(f.name || '');
        if (n) name = n;
        if (/bold|black|heavy|semibold|demibold|extrabold/i.test(n)) bold = true;
        if (/italic|oblique/i.test(n)) italic = true;
      }
    } catch {
      /* font not resolved yet — fall through */
    }
    const m = { bold, italic, name };
    fontCache.set(fontName, m);
    return m;
  };

  const runs: Run[] = [];
  let chars = 0;
  let area = 0;
  let rotatedSkipped = 0;

  for (const item of tc.items as any[]) {
    if (typeof item.str !== 'string' || !item.str.trim()) continue;
    const [a, b, c, d, e, f] = item.transform as number[];
    // rotated / vertical text: skip (sidebars, watermarks) rather than corrupt reading order
    const angle = Math.atan2(b, a);
    if (Math.abs(angle) > 0.08 || Math.abs(Math.atan2(c, d)) > 0.08 && Math.abs(angle) > 0.08) {
      rotatedSkipped++;
      continue;
    }
    const size = Math.hypot(c, d) || item.height || 10;
    const style = tc.styles[item.fontName];
    let asc = style?.ascent ?? 0.8;
    let desc = style?.descent ?? -0.2;
    if (!(asc > 0)) asc = 0.8;
    if (desc > 0) desc = -desc;
    if (!(desc < 0)) desc = -0.2;
    let h = size * (asc - desc);
    h = Math.min(Math.max(h, size * 0.7), size * 1.4);
    const baselineTop = vp.height - f;
    const y = baselineTop - size * asc;
    const w = item.width || size * item.str.length * 0.5;
    const fm = meta(item.fontName);
    runs.push({
      text: item.str,
      x: e,
      y,
      w,
      h,
      size,
      bold: fm.bold,
      italic: fm.italic,
      font: fm.name,
      conf: 100,
      src: 'native',
    });
    chars += item.str.trim().length;
    area += w * h;
  }

  return {
    runs,
    chars,
    coverage: area / (vp.width * vp.height),
    width: vp.width,
    height: vp.height,
    rotatedSkipped,
  };
}

/** Render the page to a canvas at the given scale. Only called when the oracle needs pixels. */
export async function renderPage(page: PDFPageProxy, scale: number): Promise<HTMLCanvasElement> {
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  // 'print' intent: no requestAnimationFrame pacing, so rendering proceeds even in a background tab
  await page.render({ canvasContext: ctx, canvas, viewport: vp, intent: 'print' } as any).promise;
  return canvas;
}

/** Crop a rectangle (canvas pixels) into a new canvas, optionally upscaled. */
export function crop(
  src: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
  upscale = 1,
): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const sx = Math.max(0, Math.floor(x));
  const sy = Math.max(0, Math.floor(y));
  const sw = Math.min(src.width - sx, Math.ceil(w));
  const sh = Math.min(src.height - sy, Math.ceil(h));
  c.width = Math.max(1, Math.round(sw * upscale));
  c.height = Math.max(1, Math.round(sh * upscale));
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}
