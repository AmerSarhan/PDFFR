/**
 * pdffr — a PDF decompiler.
 *
 * Native glyph coordinates are lowered to positioned runs and decompiled into markdown
 * structure in milliseconds, with no rasterization. A render-diff oracle finds the ink the
 * text layer cannot explain (scans, stamps, screenshots) and sends only those regions to a
 * pool of on-device OCR workers, whose words join the same geometry engine.
 *
 * This module is runtime-agnostic; `pdffr` (browser) and `pdffr/node` configure the runtime
 * and re-export it.
 */
import { runPipeline } from './engine/pipeline';
import { OcrPool } from './engine/ocr';
import { blocksToMarkdown, joinPages } from './engine/markdown';
import { setPdfWorkerSrc } from './engine/pdf';
import type { Block, PageState, PipelineEvent, Stats } from './engine/types';

export type {
  Block,
  ListItem,
  PageState,
  PipelineEvent,
  Region,
  Rules,
  Run,
  Stats,
  TraceKind,
} from './engine/types';
export { OcrPool, type OcrPoolOptions } from './engine/ocr';
export { blocksToMarkdown, joinPages } from './engine/markdown';
export { runPipeline, type PipelineOptions } from './engine/pipeline';
export { setPdfWorkerSrc } from './engine/pdf';
export { buildLines, orderRuns } from './engine/layout';
export type { Env, CanvasLike } from './engine/env';

export interface DecompileOptions {
  /** Escalate unexplained ink to on-device OCR. Default true. */
  ocr?: boolean;
  /** tesseract language(s) for OCR, e.g. 'eng', 'deu', 'eng+ara'. Default 'eng'. */
  lang?: string;
  /** Pages decompiled concurrently in the native pass. Default 4. */
  concurrency?: number;
  /** Reuse your own worker pool; otherwise a shared module-level pool is used. */
  pool?: OcrPool;
  /** Every pipeline event: trace lines, per-page (re)emits, stats. */
  onEvent?: (e: PipelineEvent) => void;
  /** Called each time a page's markdown is (re)computed — first native, then as OCR fills in. */
  onPage?: (page: number, markdown: string, blocks: Block[]) => void;
  /** URL of pdf.js's worker script. Defaults to the jsdelivr build matching the installed pdfjs-dist. */
  pdfWorkerSrc?: string;
}

export interface DecompiledPage {
  page: number;
  markdown: string;
  blocks: Block[];
  state: PageState;
}

export interface DecompileResult {
  markdown: string;
  pages: DecompiledPage[];
  stats: Stats;
}

let sharedPool: OcrPool | null = null;

/** The shared OCR pool for `lang` (default English). Call `.warm()` early so a scan never waits on model download. */
export function ocrPool(lang = 'eng'): OcrPool {
  if (sharedPool && sharedPool.lang !== lang) {
    void sharedPool.terminate();
    sharedPool = null;
  }
  if (!sharedPool) sharedPool = new OcrPool({ lang });
  return sharedPool;
}

/** Pre-load the OCR workers in the background. Text-only PDFs never need them. */
export function warmOcr(lang = 'eng'): Promise<void> {
  return ocrPool(lang).warm();
}

/** Shut down the shared OCR workers (lets a Node process exit). */
export async function terminateOcr(): Promise<void> {
  if (sharedPool) {
    await sharedPool.terminate();
    sharedPool = null;
  }
}

async function toBuffer(input: ArrayBuffer | Uint8Array | Blob): Promise<ArrayBuffer | Uint8Array> {
  if (input instanceof ArrayBuffer || input instanceof Uint8Array) return input;
  return input.arrayBuffer();
}

/** Decompile a PDF to markdown. Resolves when every page — including OCR'd regions — is final. */
export async function decompile(
  input: ArrayBuffer | Uint8Array | Blob,
  opts: DecompileOptions = {},
): Promise<DecompileResult> {
  if (opts.pdfWorkerSrc) setPdfWorkerSrc(opts.pdfWorkerSrc);
  const data = await toBuffer(input);
  const pages = new Map<number, DecompiledPage>();
  let stats: Stats | null = null;
  await runPipeline(
    data,
    (e) => {
      opts.onEvent?.(e);
      if (e.type === 'page') {
        const markdown = blocksToMarkdown(e.blocks);
        pages.set(e.page, { page: e.page, markdown, blocks: e.blocks, state: e.state });
        opts.onPage?.(e.page, markdown, e.blocks);
      } else if (e.type === 'done') stats = e.stats;
    },
    { ocr: opts.pool ?? ocrPool(opts.lang), concurrency: opts.concurrency, escalate: opts.ocr ?? true },
  );
  const ordered = [...pages.values()].sort((a, b) => a.page - b.page);
  return {
    markdown: joinPages(ordered.map((p) => p.markdown)),
    pages: ordered,
    stats: stats!,
  };
}
