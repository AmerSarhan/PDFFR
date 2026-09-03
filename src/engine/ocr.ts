import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import type { OcrResult, Region, Run } from './types';
import { crop } from './pdf';
import { getEnv, type CanvasLike } from './env';

type Job<T> = { fn: (w: Worker) => Promise<T>; resolve: (v: T) => void; reject: (e: any) => void };

/* ---------- text plausibility: confidence lies on graphics, shape doesn't ---------- */

const NUMERIC = /^[+\-−±~$€£(]?\p{N}[\p{N}.,:%/\-]*[)%]?$/u;
// two letters, or a single CJK character (a word on its own in those scripts)
const WORDY = /\p{L}{2,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const ALNUM = /[\p{L}\p{N}]/gu;
const PUNCT_ONLY = /^[&—–\-/+:;,.()"'“”‘’…•·،؛؟]+$/u;

/** Does this token look like a word, a number, or ordinary punctuation that lives between words? */
function wordOk(t: string, conf: number): boolean {
  const alnum = (t.match(ALNUM) || []).length;
  if (!alnum) return conf >= 55 && t.length <= 2 && PUNCT_ONLY.test(t);
  if (alnum / t.length < 0.5 && !NUMERIC.test(t)) return false;
  if (t.length === 1) return conf >= 88 || WORDY.test(t);
  // real-looking words get a little more benefit of the doubt than fragments
  return conf >= 55 || (conf >= 45 && /\p{L}{3,}/u.test(t));
}

/** Does the line as a whole read like text (not a chart axis, icon strip, or noise)? */
function lineOk(words: string[]): boolean {
  const content = words.filter((w) => ALNUM.test(w) && (ALNUM.lastIndex = 0) === 0);
  if (!content.length) return false;
  const wordy = content.filter((w) => WORDY.test(w)).length;
  const numeric = content.filter((w) => NUMERIC.test(w)).length;
  if (wordy + numeric < Math.max(1, content.length * 0.5)) return false;
  return wordy >= 1 || content.some((w) => /\p{N}{2,}/u.test(w));
}

function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}

/**
 * Ink density and colour fraction inside a box of the crop. Glyphs are unsaturated strokes;
 * an icon is solid, coloured, or both.
 */
function tokenStats(
  pix: { data: Uint8ClampedArray; width: number; height: number },
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { density: number; color: number } {
  const xa = Math.max(0, Math.floor(x0));
  const ya = Math.max(0, Math.floor(y0));
  const xb = Math.min(pix.width, Math.ceil(x1));
  const yb = Math.min(pix.height, Math.ceil(y1));
  let n = 0;
  let dark = 0;
  let nonWhite = 0;
  let colored = 0;
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const o = (y * pix.width + x) << 2;
      const r = pix.data[o];
      const g = pix.data[o + 1];
      const b = pix.data[o + 2];
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      n++;
      if ((r * 299 + g * 587 + b * 114) / 1000 < 160) dark++;
      if (mn < 225) {
        nonWhite++;
        if (mx - mn > 50) colored++;
      }
    }
  }
  return { density: n ? dark / n : 0, color: nonWhite ? colored / nonWhite : 0 };
}

export interface OcrPoolOptions {
  /** tesseract language(s), e.g. 'eng', 'deu', 'eng+ara'. Default 'eng'. */
  lang?: string;
  /** worker count; default min(4, cores − 1) */
  size?: number;
}

/** A small pool of tesseract workers with a FIFO queue. Warmed lazily so text-only PDFs never pay for it. */
export class OcrPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Job<any>[] = [];
  private initPromise: Promise<void> | null = null;
  readonly lang: string;
  size: number;
  ready = false;
  onStatus: (s: string) => void = () => {};

  constructor(opts: OcrPoolOptions = {}) {
    this.lang = opts.lang || 'eng';
    this.size = opts.size ?? Math.min(4, Math.max(1, (globalThis.navigator?.hardwareConcurrency || 2) - 1));
  }

  warm(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      this.onStatus(`warming ${this.size} OCR worker${this.size > 1 ? 's' : ''} (${this.lang})`);
      const t0 = performance.now();
      const extra = getEnv().ocrWorkerOptions || {};
      const ws = await Promise.all(
        Array.from({ length: this.size }, () =>
          createWorker(this.lang, OEM.LSTM_ONLY, { errorHandler: () => {}, ...extra } as any),
        ),
      );
      for (const w of ws)
        await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1' });
      this.workers = ws;
      this.idle = [...ws];
      this.ready = true;
      this.onStatus(`${this.size} OCR workers ready · ${Math.round(performance.now() - t0)}ms`);
      this.pump();
    })();
    return this.initPromise;
  }

  private pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!;
      const job = this.queue.shift()!;
      job
        .fn(w)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.idle.push(w);
          this.pump();
        });
    }
  }

  private run<T>(fn: (w: Worker) => Promise<T>): Promise<T> {
    void this.warm();
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      if (this.ready) this.pump();
    });
  }

  /**
   * OCR one region of a page raster into runs in page units. Doubtful words get a second
   * read at 2×; then every word and line must look like text, or the region is rejected as graphics.
   */
  recognizeRegion(raster: CanvasLike, scale: number, region: Region, wholePage: boolean): Promise<OcrResult> {
    // small crops (UI chrome, captions) are upsampled so glyphs reach a size the LSTM likes
    const px = region.h * scale;
    const up = px < 50 ? 3 : px < 90 ? 2 : 1;
    const img = crop(raster, region.x * scale, region.y * scale, region.w * scale, region.h * scale, up);
    const s = scale * up;
    const env = getEnv();
    return this.run(async (w) => {
      await w.setParameters({ tessedit_pageseg_mode: wholePage ? PSM.AUTO : PSM.SINGLE_BLOCK });
      const res = await w.recognize(env.toOcrImage(img) as any, {}, { blocks: true, text: false });
      type W = { run: Run; bx0: number; by0: number; bx1: number; by1: number; lineId: number };
      let words: W[] = [];
      let lineId = 0;
      for (const b of res.data.blocks || []) {
        for (const p of b.paragraphs) {
          for (const ln of p.lines) {
            lineId++;
            const lh = ln.bbox.y1 - ln.bbox.y0;
            const rowH = ln.rowAttributes?.rowHeight || lh;
            const size = Math.max(4, (Math.min(lh, rowH * 1.15) / s) * 0.92);
            // anchor to the baseline so words from different tesseract blocks on one row still share a line
            const basePx = ln.baseline?.y0 ?? ln.bbox.y1;
            const top = region.y + (basePx - lh * 0.8) / s;
            for (const wd of ln.words) {
              const text = wd.text.trim();
              if (!text || wd.confidence < 30) continue;
              words.push({
                run: {
                  text,
                  x: region.x + wd.bbox.x0 / s,
                  y: top,
                  w: (wd.bbox.x1 - wd.bbox.x0) / s,
                  h: lh / s,
                  size,
                  bold: false,
                  italic: false,
                  conf: wd.confidence,
                  src: 'ocr',
                },
                bx0: wd.bbox.x0,
                by0: wd.bbox.y0,
                bx1: wd.bbox.x1,
                by1: wd.bbox.y1,
                lineId,
              });
            }
          }
        }
      }

      // icons read as a digit or a letter: judged against the line's own glyphs, not an absolute.
      // Text is unsaturated strokes; an icon is either solid (density ≫ the line's) or coloured.
      const pix = img
        .getContext('2d', { willReadFrequently: true })
        .getImageData(0, 0, img.width, img.height);
      const stats = new Map<W, { density: number; color: number }>();
      for (const x of words) stats.set(x, tokenStats(pix, x.bx0, x.by0, x.bx1, x.by1));
      const isShort = (x: W) =>
        x.run.text.length <= 3 && /^[\p{N}\p{L}]+$/u.test(x.run.text) && !WORDY.test(x.run.text);
      const allDens = median(words.filter((x) => WORDY.test(x.run.text)).map((x) => stats.get(x)!.density));
      const lineGroups = new Map<number, W[]>();
      for (const x of words) lineGroups.set(x.lineId, [...(lineGroups.get(x.lineId) || []), x]);
      const kept = new Set<W>();
      for (const ws of lineGroups.values()) {
        const lineDens =
          median(ws.filter((x) => WORDY.test(x.run.text)).map((x) => stats.get(x)!.density)) || allDens;
        for (const x of ws) {
          if (!isShort(x)) {
            kept.add(x);
            continue;
          }
          const s = stats.get(x)!;
          const solid = s.density > Math.max(0.38, lineDens * 1.7);
          if (!solid && s.color < 0.35) kept.add(x);
        }
      }
      words = words.filter((x) => kept.has(x));

      // second opinion for doubtful words: 2× crop, single-word segmentation
      let reOcr = 0;
      const doubtful = words
        .filter((x) => x.run.conf < 66 && x.run.text.length >= 3 && /\p{L}/u.test(x.run.text))
        .sort((a, b) => a.run.conf - b.run.conf)
        .slice(0, 6);
      if (doubtful.length) {
        await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_WORD });
        for (const d of doubtful) {
          const pad = Math.max(3, (d.by1 - d.by0) * 0.35);
          const c = crop(img, d.bx0 - pad, d.by0 - pad, d.bx1 - d.bx0 + pad * 2, d.by1 - d.by0 + pad * 2, 2);
          try {
            const r2 = await w.recognize(env.toOcrImage(c) as any, {}, { blocks: true, text: false });
            const word = (r2.data.blocks || [])
              .flatMap((b) => b.paragraphs)
              .flatMap((p) => p.lines)
              .flatMap((l) => l.words)[0];
            if (word && word.confidence > d.run.conf + 4 && word.text.trim()) {
              d.run.text = word.text.trim();
              d.run.conf = word.confidence;
              reOcr++;
            }
          } catch {
            /* keep first reading */
          } finally {
            env.release(c);
          }
        }
      }

      // plausibility gate: line shape decides, then each surviving line keeps its words and punctuation
      const byLine = new Map<number, W[]>();
      for (const x of words) byLine.set(x.lineId, [...(byLine.get(x.lineId) || []), x]);
      const goodLines = [...byLine.values()]
        .map((ws) => ws.filter((x) => wordOk(x.run.text, x.run.conf)))
        .filter((ws) => ws.length && lineOk(ws.map((x) => x.run.text)));
      const letters = goodLines.flat().reduce((a, x) => a + (x.run.text.match(/\p{L}/gu) || []).length, 0);
      const runs = goodLines.flat().map((x) => x.run);
      const confN = runs.length;
      const meanConf = confN ? runs.reduce((a, r) => a + r.conf, 0) / confN : 0;
      // reject only when nothing substantial survived — a chart's title still counts even if its cells don't
      const rejected = !runs.length || letters < 6 || meanConf < 60;
      env.release(img);
      return { region, runs: rejected ? [] : runs, meanConf, reOcr, rejected };
    });
  }

  async terminate() {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
    this.idle = [];
    this.ready = false;
    this.initPromise = null;
  }
}
