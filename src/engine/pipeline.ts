import { crop, pageImages, extractNative, loadDoc, renderPage, type PDFPageProxy } from './pdf';
import { findRegions } from './oracle';
import { OcrPool } from './ocr';
import { buildLines, orderRuns } from './layout';
import { bodySize, computeDropSet, countBlocks, toBlocks, type LayoutItem } from './structure';
import type { Block, PageState, PipelineEvent, Region, Stats, TraceKind } from './types';

export interface PipelineOptions {
  ocr: OcrPool;
  /** pages processed concurrently in the native pass */
  concurrency?: number;
  /** enable OCR escalation */
  escalate?: boolean;
}

/** ~210 dpi for OCR crops; capped so oversized pages don't allocate absurd canvases. */
function ocrScale(pageW: number): number {
  return Math.min(4, Math.max(2, 1800 / pageW));
}

/** Split a text-less page into OCR chunks along its own ink so the pool can work in parallel. */
function chunkScan(raster: HTMLCanvasElement, scale: number, w: number, h: number): Region[] {
  const comps = findRegions(raster, scale, [], [], w, h);
  if (!comps.length) return [{ x: 0, y: 0, w, h }];
  return coalesce(comps);
}

/** Large figure regions get the same treatment: split along their ink so the pool can parallelize. */
function splitLarge(raster: HTMLCanvasElement, scale: number, regions: Region[], pageArea: number): Region[] {
  const out: Region[] = [];
  for (const r of regions) {
    if (r.w * r.h < pageArea * 0.12) { out.push(r); continue; }
    const sub = crop(raster, r.x * scale, r.y * scale, r.w * scale, r.h * scale);
    const comps = findRegions(sub, scale, [], [], r.w, r.h).map((c) => ({ x: c.x + r.x, y: c.y + r.y, w: c.w, h: c.h }));
    if (comps.length >= 2) out.push(...coalesce(comps));
    else out.push(r);
  }
  return out;
}

function coalesce(comps: Region[]): Region[] {
  // components that share rows (a table's columns, a figure beside its caption) are one band —
  // unless both are wide enough to be prose columns, which must stay apart for reading order
  const pageW = Math.max(...comps.map((c) => c.x + c.w));
  const bands: Region[] = [];
  for (const c of comps.sort((a, b) => a.y - b.y)) {
    const hit = bands.find((b) => c.y < b.y + b.h && b.y < c.y + c.h && !(b.w > pageW * 0.3 && c.w > pageW * 0.3));
    if (hit) {
      const x = Math.min(hit.x, c.x), y = Math.min(hit.y, c.y);
      hit.w = Math.max(hit.x + hit.w, c.x + c.w) - x;
      hit.h = Math.max(hit.y + hit.h, c.y + c.h) - y;
      hit.x = x; hit.y = y;
    } else bands.push({ ...c });
  }
  comps = bands;
  // keep the job count bounded: merge y-adjacent components until ≤ 10 chunks
  const chunks = comps.sort((a, b) => a.y - b.y);
  while (chunks.length > 10) {
    let bi = 0;
    let bd = Infinity;
    for (let i = 1; i < chunks.length; i++) {
      const d = chunks[i].y - (chunks[i - 1].y + chunks[i - 1].h);
      if (d < bd) { bd = d; bi = i; }
    }
    const a = chunks[bi - 1];
    const b = chunks[bi];
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    chunks.splice(bi - 1, 2, { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y });
  }
  return chunks;
}

/**
 * Decompile a PDF. Native text for every page streams out first (milliseconds), with
 * placeholders wherever the render-diff oracle found unexplained ink; OCR results then
 * replace those placeholders in place as the worker pool finishes.
 */
export async function runPipeline(data: ArrayBuffer, emit: (e: PipelineEvent) => void, opts: PipelineOptions) {
  const t0 = performance.now();
  const now = () => performance.now() - t0;
  const trace = (kind: TraceKind, msg: string) => emit({ type: 'trace', kind, msg, t: now() });
  const escalate = opts.escalate ?? true;

  const kb = (data.byteLength / 1024).toFixed(0); // read before pdf.js transfers the buffer to its worker
  const doc = await loadDoc(data);
  const n = doc.numPages;
  trace('info', `opened document · ${n} page${n > 1 ? 's' : ''} · ${kb} KB`);

  const states: PageState[] = [];
  const drop = new Set<string>();
  const stats: Stats = {
    pages: n, firstOutputMs: 0, nativeDoneMs: 0, totalMs: 0, blocks: 0,
    nativePages: 0, escPages: 0, ocrRegions: 0, ocrDone: 0, nativeChars: 0, ocrChars: 0,
  };
  const ocrJobs: Promise<void>[] = [];

  const layoutPage = (st: PageState): Block[] => {
    const items: LayoutItem[] = [];
    // native text: one reading-order tree for the page
    if (st.native.length) {
      items.push(...orderRuns(st.native));
    }
    // each OCR'd region is its own little document, placed where the image sat
    const done = new Set(st.ocr.map((o) => o.region));
    // a scanned page's OCR *is* the document (headings count); a figure inside a text page is not
    const scanned = st.nativeChars < 20;
    const scanBody = scanned ? bodySize(buildLines(st.ocr.flatMap((o) => o.runs))) : 0;
    for (const o of st.ocr) {
      if (!o.runs.length) continue;
      const leaves = orderRuns(o.runs);
      items.push({
        kind: 'group', y0: o.region.y, x0: o.region.x, leaves,
        body: scanned ? scanBody : bodySize(buildLines(o.runs)), headings: scanned,
      });
    }
    for (const r of st.regions) {
      if (!done.has(r)) items.push({ kind: 'pending', y0: r.y, x0: r.x, label: `OCR in progress · region ${Math.round(r.w)}×${Math.round(r.h)}pt` });
    }
    if (!items.length) return [];
    const body = bodySize(buildLines(st.native));
    return toBlocks(items, body, st.height, drop, n > 1);
  };
  const emitPage = (st: PageState) => {
    st.blocks = layoutPage(st);
    emit({ type: 'page', page: st.page, blocks: st.blocks, state: st });
  };
  const refreshStats = (final = false) => {
    stats.blocks = states.reduce((a, s) => a + countBlocks(s.blocks), 0);
    stats.nativeChars = states.reduce((a, s) => a + s.nativeChars, 0);
    stats.ocrChars = states.reduce((a, s) => a + s.ocrChars, 0);
    stats.totalMs = now();
    emit({ type: final ? 'done' : 'stats', stats: { ...stats } });
  };

  // ---------- native pass: all pages, concurrently ----------
  const processPage = async (i: number) => {
    const tp = performance.now();
    const page: PDFPageProxy = await doc.getPage(i);
    // the operator list is needed for the image check and it also resolves fonts (bold/italic)
    const [img, ext] = await Promise.all([pageImages(page), extractNative(page)]);
    const images = img.count;
    const st: PageState = {
      page: i, width: ext.width, height: ext.height, native: ext.runs, ocr: [], regions: [],
      pendingRegions: 0, blocks: [], nativeChars: ext.chars, ocrChars: 0, escalated: false, nativeMs: 0,
    };
    states[i - 1] = st;
    if (ext.chars > 0) stats.nativePages++;
    if (ext.rotatedSkipped) trace('warn', `page ${i} · skipped ${ext.rotatedSkipped} rotated run(s)`);
    trace('native', `page ${i} · ${ext.chars} chars from glyph coords · ${images} bitmap(s)`);

    // ---------- render-diff oracle: only when pixels could hide text ----------
    const suspicious = escalate && (images > 0 || ext.chars < 20 || ext.coverage < 0.015);
    if (suspicious) {
      const scale = ocrScale(ext.width);
      const raster = await renderPage(page, scale);
      let regions: Region[];
      const scanned = ext.chars < 20;
      if (scanned) {
        regions = chunkScan(raster, scale, ext.width, ext.height);
        trace('esc', `page ${i} · no text layer · split along its own ink into ${regions.length} OCR chunk(s)`);
      } else {
        regions = splitLarge(raster, scale, findRegions(raster, scale, ext.runs, img.rects, ext.width, ext.height), ext.width * ext.height);
        if (regions.length) trace('esc', `page ${i} · ${img.rects.length} bitmap rect(s) + render-diff → ${regions.length} region(s) to OCR`);
        else trace('struct', `page ${i} · render-diff: every ink pixel explained by native text · no OCR`);
      }
      if (regions.length) {
        st.regions = regions;
        st.pendingRegions = regions.length;
        st.escalated = true;
        stats.escPages++;
        stats.ocrRegions += regions.length;
        // release the raster once every region of this page has been read
        let left = regions.length;
        const release = () => { if (--left === 0) { raster.width = 0; raster.height = 0; } };
        for (const region of regions) {
          const whole = !scanned && region.w * region.h > ext.width * ext.height * 0.6;
          ocrJobs.push(
            opts.ocr.recognizeRegion(raster, scale, region, whole).finally(release).then(
              (r) => {
                st.ocr.push(r);
                st.ocrChars += r.runs.reduce((a, x) => a + x.text.length, 0);
                st.pendingRegions--;
                stats.ocrDone++;
                const dim = `${Math.round(region.w)}×${Math.round(region.h)}pt`;
                if (r.rejected) trace('ocr', `page ${i} · region ${dim} · rejected as graphics (no plausible text)`);
                else trace('ocr', `page ${i} · region ${dim} · ${r.runs.length} words · conf ${r.meanConf.toFixed(0)}${r.reOcr ? ` · ${r.reOcr} re-read at 2×` : ''}`);
                emitPage(st);
                refreshStats();
              },
              (err) => {
                st.ocr.push({ region, runs: [], meanConf: 0, reOcr: 0, rejected: true });
                st.pendingRegions--;
                stats.ocrDone++;
                trace('warn', `page ${i} · OCR failed: ${String(err?.message || err)}`);
                emitPage(st);
              },
            ),
          );
        }
      }
    }
    st.nativeMs = performance.now() - tp;
    emitPage(st);
    if (!stats.firstOutputMs) stats.firstOutputMs = now();
    refreshStats();
    page.cleanup();
  };

  const conc = opts.concurrency ?? 4;
  let next = 1;
  await Promise.all(
    Array.from({ length: Math.min(conc, n) }, async () => {
      while (next <= n) {
        const i = next++;
        await processPage(i);
      }
    }),
  );
  stats.nativeDoneMs = now();

  // ---------- document-level pass: headers/footers ----------
  const dropSet = computeDropSet(states.map((s) => ({ lines: buildLines(s.native), height: s.height })));
  if (dropSet.size) {
    for (const k of dropSet) drop.add(k);
    trace('struct', `stripped ${dropSet.size} running header/footer pattern(s): ${[...dropSet].slice(0, 3).map((k) => `"${k.slice(0, 28)}"`).join(', ')}`);
    for (const st of states) emitPage(st);
  }
  trace('native', `native pass complete · ${stats.nativeDoneMs.toFixed(0)}ms · ${stats.nativePages}/${n} pages carried a text layer`);
  refreshStats();

  // ---------- wait for the OCR pool to drain ----------
  if (ocrJobs.length) {
    trace('ocr', `${ocrJobs.length} region(s) queued on ${opts.ocr.size} OCR worker(s)`);
    await Promise.allSettled(ocrJobs);
  }
  stats.totalMs = now();
  trace('done', `decompiled ${n} page${n > 1 ? 's' : ''} · native in ${stats.nativeDoneMs.toFixed(0)}ms · total ${stats.totalMs.toFixed(0)}ms · ${stats.ocrRegions} OCR region(s)`);
  refreshStats(true);
  await doc.loadingTask.destroy();
}
