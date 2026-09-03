import type { Region, Run } from './types';

/**
 * Render-diff oracle.
 *
 * Mark every "ink" pixel of the page raster, then erase the (dilated) boxes of every glyph we
 * already recovered natively. Whatever ink is left is, by construction, content the text layer
 * does not explain: scans, stamps, figures with burned-in text. Combined with the exact image
 * rectangles the operator list gives us, those are the only pixels worth sending to OCR.
 */
export function findRegions(
  canvas: HTMLCanvasElement,
  scale: number,
  native: Run[],
  imageRects: Region[],
  pageW: number,
  pageH: number,
): Region[] {
  const W = canvas.width;
  const H = canvas.height;
  const CELL = Math.max(6, Math.round(6 * scale)); // grid cell in canvas px (≈6pt)
  const gw = Math.ceil(W / CELL);
  const gh = Math.ceil(H / CELL);
  const ink = new Uint16Array(gw * gh);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const data = ctx.getImageData(0, 0, W, H).data;

  // ink density per cell (every 2nd pixel)
  for (let y = 0; y < H; y += 2) {
    const row = y * W;
    const gy = (y / CELL) | 0;
    for (let x = 0; x < W; x += 2) {
      const i = (row + x) << 2;
      if (data[i + 3] < 40) continue;
      const lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      if (lum < 200) ink[gy * gw + ((x / CELL) | 0)]++;
    }
  }
  const cellMax = (CELL * CELL) / 4;
  const toCell = (v: number, max: number) => Math.min(max, Math.max(0, ((v * scale) / CELL) | 0));

  // 1. exact image rectangles, kept when they actually carry ink and aren't just a backdrop under native text
  const regions: Region[] = [];
  const covered = new Uint8Array(gw * gh);
  const pageArea = pageW * pageH;
  for (const r of imageRects) {
    if (r.w * r.h < pageArea * 0.0025) continue;
    const x0 = toCell(r.x, gw - 1),
      x1 = toCell(r.x + r.w, gw - 1);
    const y0 = toCell(r.y, gh - 1),
      y1 = toCell(r.y + r.h, gh - 1);
    let inked = 0,
      cells = 0;
    for (let gy = y0; gy <= y1; gy++)
      for (let gx = x0; gx <= x1; gx++) {
        cells++;
        if (ink[gy * gw + gx] / cellMax > 0.02) inked++;
      }
    const textInside = native
      .filter((t) => t.x >= r.x && t.x + t.w <= r.x + r.w && t.y >= r.y && t.y + t.h <= r.y + r.h)
      .reduce((a, t) => a + t.w * t.h, 0);
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) covered[gy * gw + gx] = 1;
    if (!cells || inked / cells < 0.005) continue; // blank/white image
    if (textInside > r.w * r.h * 0.25) continue; // background image beneath real text
    regions.push({ x: r.x, y: r.y, w: r.w, h: r.h });
  }

  // 2. residual ink outside those rectangles and outside native glyph boxes (vector-drawn text, stamps)
  const textMask = new Uint8Array(gw * gh);
  for (const r of native) {
    const pad = r.h * 0.4;
    const x0 = toCell(r.x - pad, gw - 1),
      x1 = toCell(r.x + r.w + pad, gw - 1);
    const y0 = toCell(r.y - pad, gh - 1),
      y1 = toCell(r.y + r.h + pad, gh - 1);
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) textMask[gy * gw + gx] = 1;
  }
  const res = new Uint8Array(gw * gh);
  for (let i = 0; i < res.length; i++)
    res[i] = !textMask[i] && !covered[i] && ink[i] / cellMax > 0.03 ? 1 : 0;

  const seen = new Uint8Array(gw * gh);
  const comps: { x0: number; y0: number; x1: number; y1: number; n: number }[] = [];
  const stack: number[] = [];
  for (let s = 0; s < res.length; s++) {
    if (!res[s] || seen[s]) continue;
    seen[s] = 1;
    stack.push(s);
    const c = { x0: gw, y0: gh, x1: 0, y1: 0, n: 0 };
    while (stack.length) {
      const i = stack.pop()!;
      const gx = i % gw,
        gy = (i / gw) | 0;
      c.n++;
      if (gx < c.x0) c.x0 = gx;
      if (gx > c.x1) c.x1 = gx;
      if (gy < c.y0) c.y0 = gy;
      if (gy > c.y1) c.y1 = gy;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = gx + dx,
            ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const j = ny * gw + nx;
          if (res[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
    }
    comps.push(c);
  }
  // merge components within ~3 cells so a card's lines stay one region
  const boxes = comps.map((c) => ({ ...c }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i],
          b = boxes[j];
        if (a.x0 <= b.x1 + 3 && b.x0 <= a.x1 + 3 && a.y0 <= b.y1 + 3 && b.y0 <= a.y1 + 3) {
          boxes[i] = {
            x0: Math.min(a.x0, b.x0),
            y0: Math.min(a.y0, b.y0),
            x1: Math.max(a.x1, b.x1),
            y1: Math.max(a.y1, b.y1),
            n: a.n + b.n,
          };
          boxes.splice(j, 1);
          merged = true;
          break outer;
        }
      }
  }
  for (const b of boxes) {
    const wCells = b.x1 - b.x0 + 1,
      hCells = b.y1 - b.y0 + 1;
    if (hCells <= 2 && wCells > 8) continue; // rules
    if (wCells <= 2 && hCells > 8) continue; // vertical rules / borders
    if (b.n < 6) continue; // specks
    const pad = 4;
    const x = Math.max(0, (b.x0 * CELL) / scale - pad);
    const y = Math.max(0, (b.y0 * CELL) / scale - pad);
    const w = Math.min(pageW - x, ((b.x1 + 1) * CELL) / scale - x + pad);
    const h = Math.min(pageH - y, ((b.y1 + 1) * CELL) / scale - y + pad);
    if (w * h < pageArea * 0.0025) continue;
    regions.push({ x, y, w, h });
  }
  regions.sort((a, b) => a.y - b.y || a.x - b.x);
  return regions;
}
