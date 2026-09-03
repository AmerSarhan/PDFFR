# pdffr

**A PDF decompiler, not an image reader.** PDF → Markdown, entirely in the browser, in milliseconds for born-digital pages — with on-device OCR spent only on the pixels the text layer can't explain.

```ts
import { decompile } from 'pdffr';

const { markdown, stats } = await decompile(file);
// stats.firstOutputMs ≈ 150ms for a typical report; the file never leaves the tab
```

## Why this exists

Every PDF→Markdown tool sits at one of two extremes:

| Approach                                                  | Speed             | Quality | Problem                                                                                                               |
| --------------------------------------------------------- | ----------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| Text-layer extraction (pdfminer, pdf.js `getTextContent`) | instant           | poor    | PDF has no paragraphs, headings, tables or reading order — you get a soup of positioned strings                       |
| Render + OCR / vision model (Textract, LlamaParse, VLMs)  | slow, paid, cloud | high    | Rasterizes a page that was _already digital_, then asks a model to re-read pixels the file could have told it exactly |

~80% of real-world PDFs are born-digital: every glyph's exact coordinates, size and font are already in the file. pdffr treats PDF as what it is — a drawing program — and **decompiles** the drawing back into structure:

- **Geometry-native decompilation.** Glyph runs → lines → an XY-cut reading-order tree over whitespace → headings (font-size clustering), paragraphs (leading analysis), nested lists (marker glyph + indent), tables (column x-alignment), inline `**bold**`/`*italic*`/`<sup>`, running header/footer stripping, hyphenation repair. No rasterization. Milliseconds per page.
- **Render-diff oracle.** When a page carries bitmaps or thin text coverage, the page is rendered once, the raster's ink mask is computed, and the dilated boxes of every native glyph are _erased_ from it. What's left is ink the text layer cannot explain — scans, stamps, screenshots with burned-in text. Exact image rectangles from the content stream (CTM-tracked) sharpen the regions further. **Only those regions** go to OCR.
- **One IR for both sources.** OCR words come back with boxes and confidence, get gated by a text-plausibility test (confidence alone lies on icons and charts), and enter the _same_ geometry engine as native glyphs. Structure recovery is source-agnostic.
- **Parallel and optimistic.** Pages decompile concurrently; markdown streams out immediately with placeholders; a pool of tesseract workers fills them in place. Whole-page scans are split along their own ink into chunks so the pool works in parallel.
- **Private by construction.** pdf.js and tesseract.js run in web workers in the user's tab. Nothing is uploaded.

## Install

```bash
npm install pdffr pdfjs-dist tesseract.js
```

`pdfjs-dist` and `tesseract.js` are peer dependencies. Browser only (needs `Worker` and canvas); a Node build is on the roadmap.

## Usage

```ts
import { decompile, warmOcr, setPdfWorkerSrc } from 'pdffr';

// Bundled apps: point pdf.js at its worker. Without this, pdffr falls back to the jsdelivr build.
setPdfWorkerSrc(new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href);

// Optional: pre-load OCR workers while the user is still choosing a file.
warmOcr();

const result = await decompile(file, {
  ocr: true, // escalate unexplained ink to on-device OCR (default true)
  concurrency: 4, // pages decompiled in parallel
  onPage(page, md) {
    // streams: first the native pass, then again as OCR regions land
    render(page, md);
  },
  onEvent(e) {
    // every trace line, page (re)emit, and stats update
    if (e.type === 'trace') console.log(e.kind, e.msg);
  },
});

result.markdown; // the whole document
result.pages[0].blocks; // typed blocks: heading | para | list | table
result.stats; // firstOutputMs, nativeDoneMs, totalMs, ocrRegions, nativeChars, ...
```

### API

- `decompile(input, options?) → Promise<DecompileResult>` — `input` is an `ArrayBuffer`, `Uint8Array`, `Blob` or `File`.
- `warmOcr()` — pre-load the shared tesseract pool.
- `ocrPool()` — the shared `OcrPool`; pass your own via `options.pool` to control worker count.
- `runPipeline(buffer, emit, { ocr, concurrency, escalate })` — the streaming core, if you want raw events.
- `blocksToMarkdown(blocks)` — render typed blocks yourself.
- `setPdfWorkerSrc(url)` — configure pdf.js's worker.

Types: `Block`, `ListItem`, `Run`, `Region`, `PageState`, `Stats`, `PipelineEvent`.

## How a page flows through

```
getTextContent ─► runs (x, y, w, h, size, bold, italic)
                   │
getOperatorList ─► exact bitmap rects (CTM walk) + font resolution
                   │
        suspicious? (bitmaps, or thin coverage)
             │ no                          │ yes
             ▼                             ▼
     structure pass                render page once (print intent)
                                   ink mask − native glyph boxes = residual
                                   regions = bitmap rects ∪ residual components
                                   large regions split along their ink
                                   ─► OCR pool (2×/3× upsampling for small crops,
                                      second read of doubtful words,
                                      text-plausibility gate)
                                   ─► OCR runs join the same structure pass
```

Structure pass: `buildLines` → `orderRuns` (XY-cut: tall prose gutter → vertical cut; largest whitespace band → horizontal cut; tables detected first as atomic boxes) → `toBlocks` (headings, lists with nesting, paragraphs by leading, tables, furniture stripping) → markdown.

## Demo

```bash
npm install
npm run dev
```

The demo (`demo/`) shows a live decompiler trace beside the streaming markdown, with sample born-digital, scanned and mixed PDFs. Drop any PDF onto it.

## Status and roadmap

Early. It is accurate on the documents it was built against (reports, Word exports with screenshots, scans, two-column layouts) and will have gaps on others. Known limitations:

- Math and multi-line equations are emitted as text, not LaTeX.
- Rotated / vertical text is skipped rather than reordered.
- Table detection relies on column alignment; ruled tables without aligned starts may come out as paragraphs.
- Icons that OCR into digits (a ⭐ read as `77`) pass the plausibility gate when they sit inside a real sentence.
- OCR language is English (`eng`); language selection is planned.
- Browser only. A Node runtime (node-canvas + worker threads) is planned.

Bug reports with a PDF attached are the fastest way to improve it.

## License

MIT © Amer Sarhan
