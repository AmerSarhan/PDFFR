import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { getEnv, type CanvasLike } from './env.js';
import type { Region, Rules, Run } from './types.js';

export type { PDFDocumentProxy, PDFPageProxy };

/** Point pdf.js at its worker script. Bundled apps usually pass `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href`. */
export function setPdfWorkerSrc(url: string) {
  getEnv().pdfjs.GlobalWorkerOptions.workerSrc = url;
}

function ensureWorker() {
  const pdfjs = getEnv().pdfjs;
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
  }
}

export function loadDoc(data: ArrayBuffer | Uint8Array): Promise<PDFDocumentProxy> {
  ensureWorker();
  const env = getEnv();
  const standardFontDataUrl =
    env.standardFontDataUrl || `https://cdn.jsdelivr.net/npm/pdfjs-dist@${env.pdfjs.version}/standard_fonts/`;
  return env.pdfjs.getDocument({ data, standardFontDataUrl }).promise;
}

export interface NativeExtract {
  runs: Run[];
  chars: number;
  /** fraction of page area covered by glyph boxes */
  coverage: number;
  width: number;
  height: number;
  /** runs at angles that are not multiples of 90° (watermarks) — dropped */
  skewedSkipped: number;
}

const MATH_FONT = /symbol|cmmi|cmsy|cmex|cmr\d|math|mtextra|euclid|stix|xits|asana|mathjax|mathpi/i;
const MATH_CHARS = /[∑∏∫√∞≤≥≠≈≡±×÷∂∇∈∉⊂⊆⊃⊇∪∩→←⇒⇔∀∃∝∅⋅αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ]/;
const MATH_CHARS_G = new RegExp(MATH_CHARS.source, 'g');
const BULLET_ONLY = /^[•‣◦▪▫■□●○·]+$/;

/**
 * Tracked (letter-spaced) text arrives as "B U S I N E S S": every token a single glyph, spaces
 * between them. Collapse it; the separate space items between words still produce word breaks.
 */
function untrack(s: string): string {
  const t = s.trim();
  const tokens = t.split(' ');
  if (tokens.length < 3) return s;
  let pairs = 0;
  for (const k of tokens) {
    if (k.length === 2) pairs++;
    else if (k.length !== 1) return s;
  }
  if (pairs > 1) return s;
  if (!/^[\p{L}\p{N}\s]+$/u.test(t)) return s;
  return s.replace(t, tokens.join(''));
}

interface FontMeta {
  bold: boolean;
  italic: boolean;
  name: string;
}

/** Lower the page's native text layer to positioned runs. Zero rasterization. */
export async function extractNative(page: PDFPageProxy): Promise<NativeExtract> {
  const vp = page.getViewport({ scale: 1 });
  const H = vp.height;
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
  let skewedSkipped = 0;

  for (const item of tc.items as any[]) {
    if (typeof item.str !== 'string' || !item.str.trim()) continue;
    const [a, b, c, d, e, f] = item.transform as number[];
    // glyph rotation: keep multiples of 90° (sidebars, landscape pages), drop skewed watermarks
    const deg = (Math.atan2(b, a) * 180) / Math.PI;
    const q = Math.round(deg / 90) * 90;
    if (Math.abs(deg - q) > 5) {
      skewedSkipped++;
      continue;
    }
    const rot = ((q % 360) + 360) % 360;
    const size = Math.hypot(c, d) || item.height || 10;
    const style = tc.styles[item.fontName];
    let asc = style?.ascent ?? 0.8;
    let desc = style?.descent ?? -0.2;
    if (!(asc > 0)) asc = 0.8;
    if (desc > 0) desc = -desc;
    if (!(desc < 0)) desc = -0.2;
    let h = size * (asc - desc);
    h = Math.min(Math.max(h, size * 0.7), size * 1.4);
    asc = h / (1 - desc / asc) / size; // keep ascent/descent proportions inside the clamped height
    desc = asc - h / size;
    const w = item.width || size * item.str.length * 0.5;

    // baseline start in top-down page coordinates; advance and glyph-up as unit vectors
    const px = e;
    const py = H - f;
    const ax = a / size;
    const ay = -b / size;
    const ux = c / size;
    const uy = -d / size;
    const x0 = px + ux * desc * size;
    const y0 = py + uy * desc * size;
    const xs = [x0, x0 + ax * w, x0 + ux * h, x0 + ax * w + ux * h];
    const ys = [y0, y0 + ay * w, y0 + uy * h, y0 + ay * w + uy * h];
    const bx = Math.min(...xs);
    const by = Math.min(...ys);
    const fm = meta(item.fontName);
    const math =
      (MATH_FONT.test(fm.name) && !BULLET_ONLY.test(item.str.trim())) ||
      (item.str.match(MATH_CHARS_G) || []).length >= 2 ||
      (item.str.trim().length >= 2 &&
        (item.str.match(MATH_CHARS_G) || []).length / item.str.trim().length >= 0.25);
    runs.push({
      text: untrack(item.str),
      x: bx,
      y: by,
      w: Math.max(...xs) - bx,
      h: Math.max(...ys) - by,
      size,
      bold: fm.bold,
      italic: fm.italic,
      font: fm.name,
      math: math || undefined,
      rot: rot || undefined,
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
    skewedSkipped,
  };
}

/**
 * Re-express runs drawn at `rot` degrees in an upright frame, so the layout engine can read
 * them as ordinary text. Returns the frame's own width and height.
 */
export function frameRuns(
  runs: Run[],
  rot: number,
  W: number,
  H: number,
): { runs: Run[]; width: number; height: number } {
  const map = (x: number, y: number): [number, number] => {
    switch (rot) {
      case 90:
        return [H - y, x];
      case 180:
        return [W - x, H - y];
      case 270:
        return [y, W - x];
      default:
        return [x, y];
    }
  };
  const out = runs.map((r) => {
    const pts = [map(r.x, r.y), map(r.x + r.w, r.y), map(r.x, r.y + r.h), map(r.x + r.w, r.y + r.h)];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { ...r, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, rot: undefined };
  });
  const swap = rot === 90 || rot === 270;
  return { runs: out, width: swap ? H : W, height: swap ? W : H };
}

/* ---------- content-stream graphics: bitmap rectangles and ruling lines ---------- */

// pdf.js path segment codes and their operand counts
const SEG_ARITY: Record<number, number> = { 0: 2, 1: 2, 2: 6, 3: 0, 4: 4, 5: 4 };

export interface PageGraphics {
  count: number;
  rects: Region[];
  rules: Rules;
}

/**
 * Walk the operator list tracking the CTM (save/restore/transform and form XObjects) so every
 * image paint resolves to an exact page rectangle and every stroked line to a ruling segment.
 * The PDF already knows this; no pixel heuristics needed.
 */
export async function pageGraphics(page: PDFPageProxy): Promise<PageGraphics> {
  const ops = await page.getOperatorList();
  const OPS: any = getEnv().pdfjs.OPS;
  const vp = page.getViewport({ scale: 1 });
  const IMAGE_OPS = new Set<number>(
    [
      OPS.paintImageXObject,
      OPS.paintImageXObjectRepeat,
      OPS.paintInlineImageXObject,
      OPS.paintInlineImageXObjectGroup,
      OPS.paintImageMaskXObject,
      OPS.paintImageMaskXObjectGroup,
      OPS.paintImageMaskXObjectRepeat,
      OPS.paintJpegXObject,
    ].filter((n) => typeof n === 'number'),
  );
  const STROKE_OPS = new Set<number>([
    OPS.stroke,
    OPS.closeStroke,
    OPS.fillStroke,
    OPS.closeFillStroke,
    OPS.eoFillStroke,
    OPS.closeEOFillStroke,
  ]);
  const FILL_OPS = new Set<number>([
    OPS.fill,
    OPS.eoFill,
    OPS.fillStroke,
    OPS.closeFillStroke,
    OPS.eoFillStroke,
    OPS.closeEOFillStroke,
  ]);

  const mul = (m1: number[], m2: number[]): number[] => [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
  const apply = (x: number, y: number, m: number[]): [number, number] => [
    x * m[0] + y * m[2] + m[4],
    x * m[1] + y * m[3] + m[5],
  ];
  const isMatrix = (a: unknown): a is number[] =>
    Array.isArray(a) && a.length >= 6 && a.every((v) => typeof v === 'number');

  let ctm: number[] = Array.from(vp.transform as number[]);
  const stack: number[][] = [];
  const rects: Region[] = [];
  const segs: [number, number, number, number][] = [];
  let count = 0;

  const addSeg = (x0: number, y0: number, x1: number, y1: number) => {
    const [ax, ay] = apply(x0, y0, ctm);
    const [bx, by] = apply(x1, y1, ctm);
    segs.push([ax, ay, bx, by]);
  };
  const addRect = (x: number, y: number, w: number, h: number, stroked: boolean, filled: boolean) => {
    const thin = Math.min(Math.abs(w), Math.abs(h)) * Math.hypot(ctm[0], ctm[1]) < 2.5;
    if (stroked || (filled && thin)) {
      if (filled && thin && !stroked) {
        // a hairline rectangle is a rule along its long axis
        if (Math.abs(w) >= Math.abs(h)) addSeg(x, y + h / 2, x + w, y + h / 2);
        else addSeg(x + w / 2, y, x + w / 2, y + h);
      } else {
        addSeg(x, y, x + w, y);
        addSeg(x + w, y, x + w, y + h);
        addSeg(x + w, y + h, x, y + h);
        addSeg(x, y + h, x, y);
      }
    }
  };

  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args: any = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm.slice());
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) {
      if (isMatrix(args)) ctm = mul(ctm, args);
    } else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm.slice());
      if (args && isMatrix(args[0])) ctm = mul(ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (IMAGE_OPS.has(fn)) {
      count++;
      if (fn === OPS.paintImageXObjectRepeat || fn === OPS.paintImageMaskXObjectRepeat) continue;
      const pts = [apply(0, 0, ctm), apply(1, 0, ctm), apply(0, 1, ctm), apply(1, 1, ctm)];
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const x = Math.max(0, Math.min(...xs));
      const y = Math.max(0, Math.min(...ys));
      const r = {
        x,
        y,
        w: Math.min(vp.width, Math.max(...xs)) - x,
        h: Math.min(vp.height, Math.max(...ys)) - y,
      };
      if (r.w > 4 && r.h > 4) rects.push(r);
    } else if (fn === OPS.constructPath && Array.isArray(args)) {
      const paint = args[0] as number;
      const stroked = STROKE_OPS.has(paint);
      const filled = FILL_OPS.has(paint);
      if (!stroked && !filled) continue;
      const paths: ArrayLike<number>[] = Array.isArray(args[1]) ? args[1] : [];
      for (const data of paths) {
        let cx = 0;
        let cy = 0;
        let sx = 0;
        let sy = 0;
        for (let k = 0; k < data.length;) {
          const code = data[k++];
          const n = SEG_ARITY[code];
          if (n === undefined) break;
          if (code === 0) {
            cx = sx = data[k];
            cy = sy = data[k + 1];
          } else if (code === 1) {
            if (stroked) addSeg(cx, cy, data[k], data[k + 1]);
            cx = data[k];
            cy = data[k + 1];
          } else if (code === 2) {
            cx = data[k + 4];
            cy = data[k + 5];
          } else if (code === 3) {
            if (stroked) addSeg(cx, cy, sx, sy);
            cx = sx;
            cy = sy;
          } else if (code === 4) {
            cx = data[k + 2];
            cy = data[k + 3];
          } else if (code === 5) {
            addRect(data[k], data[k + 1], data[k + 2], data[k + 3], stroked, filled);
            cx = sx = data[k];
            cy = sy = data[k + 1];
          }
          k += n;
        }
      }
    }
  }

  // classify segments into horizontal / vertical rules and merge collinear pieces
  const h: Rules['h'] = [];
  const v: Rules['v'] = [];
  for (const [x0, y0, x1, y1] of segs) {
    if (Math.abs(y1 - y0) < 0.6 && Math.abs(x1 - x0) >= 6)
      h.push({ y: (y0 + y1) / 2, x0: Math.min(x0, x1), x1: Math.max(x0, x1) });
    else if (Math.abs(x1 - x0) < 0.6 && Math.abs(y1 - y0) >= 6)
      v.push({ x: (x0 + x1) / 2, y0: Math.min(y0, y1), y1: Math.max(y0, y1) });
  }
  const mergeH = (list: Rules['h']) => {
    list.sort((a, b) => a.y - b.y || a.x0 - b.x0);
    const out: Rules['h'] = [];
    for (const r of list) {
      const last = out[out.length - 1];
      if (last && Math.abs(last.y - r.y) < 1.2 && r.x0 <= last.x1 + 2) {
        last.x1 = Math.max(last.x1, r.x1);
        last.y = (last.y + r.y) / 2;
      } else out.push({ ...r });
    }
    return out;
  };
  const mergeV = (list: Rules['v']) => {
    list.sort((a, b) => a.x - b.x || a.y0 - b.y0);
    const out: Rules['v'] = [];
    for (const r of list) {
      const last = out[out.length - 1];
      if (last && Math.abs(last.x - r.x) < 1.2 && r.y0 <= last.y1 + 2) {
        last.y1 = Math.max(last.y1, r.y1);
        last.x = (last.x + r.x) / 2;
      } else out.push({ ...r });
    }
    return out;
  };
  return { count, rects, rules: { h: mergeH(h), v: mergeV(v) } };
}

/* ---------- rasters ---------- */

/** Render the page to a canvas at the given scale. Only called when the oracle needs pixels. */
export async function renderPage(page: PDFPageProxy, scale: number): Promise<CanvasLike> {
  const vp = page.getViewport({ scale });
  const canvas = getEnv().createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // 'print' intent: no requestAnimationFrame pacing, so rendering proceeds even in a background tab
  await page.render({ canvasContext: ctx, canvas, viewport: vp, intent: 'print' } as any).promise;
  return canvas;
}

/** Crop a rectangle (canvas pixels) into a new canvas, optionally upscaled. */
export function crop(src: CanvasLike, x: number, y: number, w: number, h: number, upscale = 1): CanvasLike {
  const sx = Math.max(0, Math.floor(x));
  const sy = Math.max(0, Math.floor(y));
  const sw = Math.max(1, Math.min(src.width - sx, Math.ceil(w)));
  const sh = Math.max(1, Math.min(src.height - sy, Math.ceil(h)));
  const c = getEnv().createCanvas(
    Math.max(1, Math.round(sw * upscale)),
    Math.max(1, Math.round(sh * upscale)),
  );
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}
