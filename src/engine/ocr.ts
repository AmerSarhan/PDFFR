import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import type { OcrResult, Region, Run } from './types';
import { crop } from './pdf';

type Job<T> = { fn: (w: Worker) => Promise<T>; resolve: (v: T) => void; reject: (e: any) => void };

/* ---------- text plausibility: confidence lies on graphics, shape doesn't ---------- */

const NUMERIC = /^[+\-−±~$€£(]?\d[\d.,:%/\-]*[)%]?$/;
const WORDY = /[A-Za-z]{2,}/;

/** Does this token look like a word, a number, or ordinary punctuation that lives between words? */
function wordOk(t: string, conf: number): boolean {
  const alnum = (t.match(/[A-Za-z0-9]/g) || []).length;
  if (!alnum) return conf >= 55 && t.length <= 2 && /^[&—–\-/+:;,.()"'“”‘’…•·]+$/.test(t);
  if (alnum / t.length < 0.5 && !NUMERIC.test(t)) return false;
  if (t.length === 1) return conf >= 88;
  // real-looking words get a little more benefit of the doubt than fragments
  return conf >= 55 || (conf >= 45 && /[A-Za-z]{3,}/.test(t));
}

/** Does the line as a whole read like text (not a chart axis, icon strip, or noise)? */
function lineOk(words: string[]): boolean {
  const content = words.filter((w) => /[A-Za-z0-9]/.test(w));
  if (!content.length) return false;
  const wordy = content.filter((w) => WORDY.test(w)).length;
  const numeric = content.filter((w) => NUMERIC.test(w)).length;
  if (wordy + numeric < Math.max(1, content.length * 0.5)) return false;
  return wordy >= 1 || content.some((w) => /\d{2,}/.test(w));
}

/** A small pool of tesseract workers with a FIFO queue. Warmed lazily so text-only PDFs never pay for it. */
export class OcrPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Job<any>[] = [];
  private initPromise: Promise<void> | null = null;
  size = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
  ready = false;
  onStatus: (s: string) => void = () => {};

  warm(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      this.onStatus(`warming ${this.size} OCR worker${this.size > 1 ? 's' : ''}`);
      const t0 = performance.now();
      const ws = await Promise.all(
        Array.from({ length: this.size }, () => createWorker('eng', OEM.LSTM_ONLY, { errorHandler: () => {} })),
      );
      for (const w of ws) await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1' });
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
      job.fn(w).then(job.resolve, job.reject).finally(() => { this.idle.push(w); this.pump(); });
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
  recognizeRegion(raster: HTMLCanvasElement, scale: number, region: Region, wholePage: boolean): Promise<OcrResult> {
    // small crops (UI chrome, captions) are upsampled so glyphs reach a size the LSTM likes
    const px = region.h * scale;
    const up = px < 50 ? 3 : px < 90 ? 2 : 1;
    const img = crop(raster, region.x * scale, region.y * scale, region.w * scale, region.h * scale, up);
    const s = scale * up;
    return this.run(async (w) => {
      await w.setParameters({ tessedit_pageseg_mode: wholePage ? PSM.AUTO : PSM.SINGLE_BLOCK });
      const res = await w.recognize(img, {}, { blocks: true, text: false });
      type W = { run: Run; bx0: number; by0: number; bx1: number; by1: number; lineId: number };
      const words: W[] = [];
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
                  text, x: region.x + wd.bbox.x0 / s, y: top,
                  w: (wd.bbox.x1 - wd.bbox.x0) / s, h: lh / s, size, bold: false, italic: false,
                  conf: wd.confidence, src: 'ocr',
                },
                bx0: wd.bbox.x0, by0: wd.bbox.y0, bx1: wd.bbox.x1, by1: wd.bbox.y1, lineId,
              });
            }
          }
        }
      }

      // second opinion for doubtful words: 2× crop, single-word segmentation
      let reOcr = 0;
      const doubtful = words
        .filter((x) => x.run.conf < 66 && x.run.text.length >= 3 && /[A-Za-z]/.test(x.run.text))
        .sort((a, b) => a.run.conf - b.run.conf)
        .slice(0, 6);
      if (doubtful.length) {
        await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_WORD });
        for (const d of doubtful) {
          const pad = Math.max(3, (d.by1 - d.by0) * 0.35);
          const c = crop(img, d.bx0 - pad, d.by0 - pad, d.bx1 - d.bx0 + pad * 2, d.by1 - d.by0 + pad * 2, 2);
          try {
            const r2 = await w.recognize(c, {}, { blocks: true, text: false });
            const word = (r2.data.blocks || []).flatMap((b) => b.paragraphs).flatMap((p) => p.lines).flatMap((l) => l.words)[0];
            if (word && word.confidence > d.run.conf + 4 && word.text.trim()) {
              d.run.text = word.text.trim();
              d.run.conf = word.confidence;
              reOcr++;
            }
          } catch { /* keep first reading */ }
        }
      }

      // plausibility gate: line shape decides, then each surviving line keeps its words and punctuation
      const byLine = new Map<number, W[]>();
      for (const x of words) byLine.set(x.lineId, [...(byLine.get(x.lineId) || []), x]);
      const goodLines = [...byLine.values()]
        .map((ws) => ws.filter((x) => wordOk(x.run.text, x.run.conf)))
        .filter((ws) => ws.length && lineOk(ws.map((x) => x.run.text)));
      const letters = goodLines.flat().reduce((a, x) => a + (x.run.text.match(/[A-Za-z]/g) || []).length, 0);
      const runs = goodLines.flat().map((x) => x.run);
      const confN = runs.length;
      const meanConf = confN ? runs.reduce((a, r) => a + r.conf, 0) / confN : 0;
      // reject only when nothing substantial survived — a chart's title still counts even if its cells don't
      const rejected = !runs.length || letters < 6 || meanConf < 60;
      img.width = 0; img.height = 0; // free the crop
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
