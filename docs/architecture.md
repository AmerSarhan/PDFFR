# Architecture

This document explains _why_ pdffr is built the way it is, and records every heuristic with its threshold and the reasoning behind it. If you are changing a number, this is the file to update.

## 1. The thesis

A PDF is a drawing program: "place glyph _g_ of font _F_ at (_x_, _y_) with size _s_". For born-digital documents the file therefore already contains the exact position, size and font of every character. Tools that render the page to pixels and run OCR or a vision model over it are throwing that away and paying a model to reconstruct what the file could have told them for free.

pdffr treats extraction as **decompilation**: recover the structure (headings, paragraphs, lists, tables, reading order) from the drawing primitives. Pixels are consulted only where the drawing primitives are silent — bitmaps — and even then only where those bitmaps carry ink the text layer does not explain.

Two consequences shape everything else:

1. **Time to first output is a native-pass property.** No page waits for OCR. The native pass runs concurrently across pages and streams blocks immediately; OCR fills placeholders in later.
2. **There is one intermediate representation.** Native glyphs and OCR words are both lowered to `Run { text, x, y, w, h, size, bold, italic, conf, src }`. Everything downstream is source-agnostic.

## 2. Pipeline

```
                ┌──────────────── per page, concurrency 4 ─────────────────┐
PDF ──► pdf.js ─┤ getTextContent ─► runs                                    │
                │ getOperatorList ─► image rects (CTM walk), font metadata  │
                │      │                                                    │
                │  suspicious?  = bitmaps > 0 | chars < 20 | coverage < 1.5%│
                │      │ no ─────────────────────────────► emit page        │
                │      │ yes                                                │
                │  render once (intent: print)                              │
                │  regions = oracle(raster, runs, image rects)              │
                │  emit page with pending placeholders                      │
                │  queue regions on the OCR pool                            │
                └───────────────────────────────────────────────────────────┘
document pass: running header/footer set ─► re-emit pages
OCR pool drains: each result ─► page re-laid out with native + OCR runs ─► re-emit
```

`intent: 'print'` matters: pdf.js paces display-intent rendering with `requestAnimationFrame`, which never fires in a background tab, so OCR rasterization would silently stall whenever the page was hidden.

## 3. Lowering the text layer (`pdf.ts`)

- Font size: `hypot(transform[2], transform[3])` — the vertical scale of the text matrix, which is what pdf.js's own text layer uses.
- Box: top = baseline − ascent·size; height = (ascent − descent)·size, clamped to [0.7, 1.4]·size because some embedded fonts report absurd metrics.
- Bold/italic: the resolved font object (`page.commonObjs`) exposes `bold`, `black`, `italic`; the font name is also matched against `/bold|black|heavy|semibold|demibold/` and `/italic|oblique/` because many subset fonts only encode weight in the name. The operator list is awaited alongside text content because that is what resolves fonts.
- Rotated runs (`|atan2(b, a)| > 0.08 rad`) are skipped rather than reordered; a sidebar's vertical text would otherwise shred the reading order of the page around it.
- Coverage = Σ(w·h) / page area. Below 1.5% the page is treated as suspicious even without bitmaps, catching vector-drawn "text" and near-empty pages.

### Image rectangles

`getOperatorList` is walked with a CTM stack: `save`/`restore`, `transform`, and `paintFormXObjectBegin/End` (which pushes the form's matrix). Every image paint op draws the unit square under the current CTM, so its page rectangle is the transformed unit square's bounding box. This is exact; no pixel heuristic can match it.

## 4. The render-diff oracle (`oracle.ts`)

Goal: the set of rectangles that might contain text the text layer does not have.

1. **Ink mask.** The raster is sampled on a grid of ~6pt cells (`CELL = round(6·scale)` px). A pixel is ink if luminance < 200 (light grey UI text must count). Every second pixel is sampled; cost is ~10 ms for a 1800×2300 raster.
2. **Image rectangles first.** Each rectangle from §3 becomes a region if it (a) covers ≥ 0.25% of the page, (b) has ink in ≥ 0.5% of its cells (a white placeholder image is not text), and (c) is not a backdrop: if native glyph boxes cover more than 25% of the rectangle, it is a background image _under_ real text and is skipped.
3. **Residual ink.** Native glyph boxes, dilated by 0.4·h to swallow anti-aliasing halos, are erased from the mask along with the image rectangles. Cells with > 3% ink density that survive are "unexplained". They are grouped by 8-connected components, merged when within 3 cells (so a card's lines stay one region), and filtered: components ≤ 2 cells tall and > 8 wide are rules; ≤ 2 wide and > 8 tall are borders; fewer than 6 cells is a speck; < 0.25% of the page area is ignored.
4. **Large regions are split along their own ink** (`splitLarge`, > 12% of page area) so the OCR pool can work in parallel — the same routine that chunks a whole-page scan.

Whole-page scans (`chars < 20`) skip step 2–3 and are chunked directly: connected components of the page's ink, coalesced into horizontal bands. Components that share rows are merged into one band — a table's columns, a figure beside its caption — _unless both are wider than 30% of the page_, which is the signature of prose columns that must stay separate for reading order. Bands are merged nearest-first until at most 10 remain.

## 5. OCR (`ocr.ts`)

- Pool size: `min(4, cores − 1)`, warmed at idle time so a scan never waits on model download; text-only documents never touch it.
- Scale: rasters target ~210 dpi (`min(4, max(2, 1800 / pageWidth))`). Crops shorter than 90 px are upsampled 2×, shorter than 50 px 3× — the LSTM wants ~30 px x-heights.
- Segmentation: `SINGLE_BLOCK` for regions, `AUTO` only for a genuine whole page inside a text page.
- Second read: up to six words with confidence < 66 and at least one letter are re-read at 2× with `SINGLE_WORD`; the new reading wins if its confidence is more than 4 points higher. Capped because each re-read is a separate worker round-trip.
- Baseline anchoring: OCR runs take `y` from tesseract's baseline, not the word box, so words from different tesseract blocks on the same row (a far-right table column) still land on one line.

### The plausibility gate

Tesseract reports 90%+ confidence on icons, chart glyphs and decorative strokes. Confidence is therefore never sufficient. Shape is:

- **Word**: must contain an alphanumeric (bare punctuation is kept only at ≤ 2 chars, e.g. `&`, `—`); alphanumerics ≥ 50% of the token unless it parses as a number (`[+−±~$€£(]?\d[\d.,:%/-]*[)%]?`); single characters need confidence ≥ 88; otherwise confidence ≥ 55, or ≥ 45 for tokens with three or more letters.
- **Line**: tokens that are words (≥ 2 letters) or numbers must be at least half of the content tokens, and the line must contain a word or a number with ≥ 2 digits. A chart axis (`1 4 3 9`) fails; a table row (`North 4,210 +12%`) passes.
- **Region**: rejected only if nothing survives, fewer than 6 letters survive, or the mean confidence of survivors is < 60. A heat-map's cells fail the line test individually while its title passes — the title is kept.

## 6. Layout (`layout.ts`)

### Lines

Runs are sorted by vertical centre and attached to the most recent line whose centre is within 0.55·min(h) — or, for a run less than 0.75× the line's height that overlaps the line's box at all, that line (superscripts and subscripts). Within a line, runs are joined with a space when the gap exceeds 0.22·size, or 0.06·size when neither side is punctuation that glues.

Inline markup: consecutive runs with the same style are merged; a run smaller than 0.72·size whose bottom sits above the line's bottom by more than 0.28·size is a superscript.

### Bullets

Word, LibreOffice and most generators emit the marker as its own run in a symbol font (`Symbol`, `Wingdings`, `Courier` for the hollow `o`) followed by a tab-sized gap. A line is a list item when its first run is ≤ 4 chars and either the gap to the next run is > 0.35·size or the font is a symbol font, and the token is a single glyph or an ordered marker (`1.`, `a)`, `iv.`). Glued markers (`- text`, `2. text`) are matched textually as a fallback. A marker alone on its line — Word's way of writing an item whose content is a picture — is dropped.

### Tables

A line is a candidate row when splitting at gaps > 1.25·size yields ≥ 2 cells (bullet glyphs excluded) each ≤ 70 chars. Consecutive candidates (vertical gap < 1.6·size) are compatible when all but one of the smaller row's cell starts align within 1.2·size. A group needs ≥ 2 rows and either a row with ≥ 3 cells or ≥ 3 rows. Column positions are clustered from all cell starts with a 1.4·size tolerance; cells are assigned to the nearest column. Lists are never rows.

### Reading order — XY-cut

Recursive, on runs, up to depth 8, for regions with ≥ 6 lines:

1. **Column gutter first.** Merge the x-intervals of runs narrower than 60% of the region (a spanning title must not block the gutter). A gap ≥ max(8pt, 1.0·size), located in the middle 60% of the region, is a gutter if both sides have ≥ 3 lines, median line length ≥ 18 chars (short cells on both sides mean a table, not columns), and both sides span ≥ 30% of the region height. Cut there; spanning runs above the columns go first, below go last. Widest gutter wins.
2. **Otherwise the largest horizontal whitespace band** greater than 1.1·size.
3. **Leaf**: tables become atomic boxes; remaining lines are grouped into vertical stretches between tables; leaves are ordered by (y, x).

Checking the gutter before horizontal bands is deliberate: XY-cut's classic failure is cutting a two-column page at a shared paragraph gap and then reading left-top, right-top, left-bottom, right-bottom.

A gutter is worth cutting at when it carries one of three signatures, and only then — a table also has gutters, and a table must never be cut:

- **Text columns**: prose on both sides (≥ 3 lines, median ≥ 18 chars) each spanning ≥ 30% of the region height.
- **Label column**: a narrow left side that is not prose beside a right side that is, with ≥ 3× as many lines. The left lines become `label` leaves — headings over the paragraphs beside them (the structure pass orders leaves by y, so each label lands above its prose). This is the "**KSA-UAE tension** — paragraph" layout of reports.
- **Card lanes**: lines that do not share baselines across the gap (fewer than half of the smaller side's lines have a partner within 0.35·size on the other side), both sides ≥ 3 lines and ≥ 30% of the region height. Table rows align across a gutter; independent lanes don't.

### Letter-spaced text

Designed headings are often tracked (`B U S I N E S S`), which pdf.js delivers as one run per glyph. When ≥ 70% of a line's runs are single glyphs (and there are ≥ 4), the median inter-run gap is the tracking; runs are joined without spaces and only a gap > 1.8× the tracking (+ 0.05·size) is a word break.

## 7. Structure (`structure.ts`)

- **Body size** is the char-weighted modal line size, rounded to 0.5pt.
- **Headings** by ratio to body: ≥ 1.7 → H1, ≥ 1.32 → H2, ≥ 1.12 → H3, each requiring ≤ 100 chars; H3 also requires no terminal punctuation. An isolated whole-bold line at ≥ 0.95·body, narrower than 85% of the leaf and separated from neighbours by > 0.35·size is an H3. Inside an OCR'd figure headings are disabled — a screenshot's card title is not part of the document outline — unless the whole page is a scan, in which case the OCR _is_ the document.
- **Paragraph breaks** compare baseline-to-baseline leading with the leaf's median leading (ignoring steps < 0.6·size, which are superscripts): a step > 1.3·median + 0.1·size breaks; so does a size change with a gap > 0.5·size, or a short line (< 72% of leaf width) ending in terminal punctuation. Font-size multiples alone were wrong in both directions: a two-line headline split, a tight paragraph merged.
- **Lists** nest by clustering marker x-positions within the leaf (0.8·size tolerance); a non-marker line indented past the item's text start with a gap < 0.9·size continues the item. Nesting can only deepen one step per item so a dropped picture-item leaves no orphan depth.
- **Hyphenation**: a line ending in `letter-` followed by a lowercase line is joined without the hyphen, except after common prefixes (`re-`, `co-`, `pre-`, `non-`, `self-`, `anti-`, `multi-`, `semi-`, `cross-`, `ex-`, `e-`).
- **Furniture**: on documents of ≥ 2 pages, normalised text (digits → `#`) in the top or bottom 9% of the page that recurs on ≥ 50% of pages is dropped, as are bare page numbers in those bands.

## 8. Rotated text (`pdf.ts` → `pipeline.ts`)

Every run's angle is `atan2(b, a)` of its text matrix. Angles within 5° of a multiple of 90° are kept with `rot ∈ {90, 180, 270}`; anything else (a diagonal watermark) is dropped, because reordering it would only corrupt the text around it. A run's page box is computed generically from its advance and glyph-up vectors, so the render-diff oracle sees rotated glyphs exactly like upright ones.

At layout time runs are grouped by rotation. If one non-zero rotation carries more than 60% of the page's characters the page itself is turned: those runs are mapped into an upright frame (`frameRuns`: 90° → `(H − y, x)`, 180° → `(W − x, H − y)`, 270° → `(y, W − x)`) and laid out as the page, with the frame's height driving furniture detection. Any other rotation (a sidebar, a rotated table header) becomes its own group, laid out in its own upright frame and placed by its page-space position, with headings disabled.

## 9. Ruled tables (`pdf.ts` → `layout.ts`)

The same CTM walk that finds bitmaps records every stroked `lineTo` and every hairline filled rectangle as a segment; segments within 0.6pt of horizontal or vertical and at least 6pt long are rules, merged when collinear within 1.2pt and touching within 2pt.

`detectRuledTables` clusters horizontal rules by y (1.5pt) into bands, then chains bands whose x-extents overlap by more than half the shorter one into frames. A frame needs two or more rules at least 8pt apart. Vertical rules that lie inside the frame's x-range and span more than half its height give column boundaries; text runs are assigned to cells by the x of their centre and the row band of their line's centre, so multi-line cells and cells whose contents don't share a left edge both work. With only top and bottom rules, rows come from baseline clusters (0.8·size); with only horizontal rules, cells come from gaps (`cells()`) and columns from clustering their starts (1.4·size). Frames with fewer than two text rows or two columns are ignored. The XY-cut never splits at a whitespace band that crosses a vertical rule.

## 10. Math (`pdf.ts` → `layout.ts` → `structure.ts`)

A run is math if its font name matches `/symbol|cmmi|cmsy|cmex|cmr\d|math|mtextra|euclid|stix|xits|asana|mathjax|mathpi/` (bullet glyphs in Symbol excepted) or its text carries a math symbol (`∑ ∫ √ ≤ ≥ ≠ ± × ÷ ∂ ∇ ∈ → α–ω Γ–Ω …`). Within a line, math runs seed spans that grow over neighbouring sub/superscripts and short tokens (`x`, `=`, `+`, `2`, `(`) within 0.6·size. A script is a run under 0.72·size whose centre sits more than 0.12·size above (superscript) or below (subscript) the base runs' centre; scripts attach to the token on their left as `_{}` / `^{}`. Greek and symbols map to LaTeX commands; a lone `Σ`/`Π` larger than 1.08·size is `\sum`/`\prod`. A span renders as `$…$`; a line that is entirely one span and stands on its own (narrower than 85% of the leaf, or gapped from its neighbours) becomes a `$$…$$` block; consecutive display lines merge into one block joined by `\\`. A text-font run that is a single italic letter carrying a script also seeds a span (math typed without a math font).

**Fractions** are folded before layout: a horizontal rule between 0.8·size and 220pt wide with runs whose bottom sits within 1.8·size above it and runs whose top sits within 1.8·size below it — each overlapping the bar by half their width, at least one of them math or a short token — collapses into one synthetic run carrying `\frac{num}{den}`, positioned on the bar. The bar is removed from the rules so it cannot form a table frame. A lone `×` or `±` in a text font is not math: text-font runs need two math symbols or a 25% symbol density. Radicands with an argument bar, matrices and `\begin{aligned}` layouts are not reconstructed.

### Cross-page paragraphs

Pages are joined by `joinPages`: when a page's markdown ends in a letter, digit, comma, semicolon or dash (not a table row) and the next page starts lowercase, the break was mid-paragraph and the pages are joined with a space.

## 11. Icons that OCR into characters (`ocr.ts`)

Tesseract will happily read a star as `77` or an info icon as `©`, at high confidence. A short token (≤ 3 characters, not a word) is compared with the glyphs on its own line using one `getImageData` of the crop: it is dropped when its ink density exceeds max(0.38, 1.7× the line's median word density) — solid shapes versus strokes — or when more than 35% of its non-white pixels are coloured (channel spread > 50), since text is unsaturated and icons rarely are. A thin grey outline icon passes both tests; that is the remaining gap.

The same per-word density gives **bold from OCR**, which tesseract's LSTM does not report: a word of ≥ 3 letters on a line with ≥ 3 words whose density exceeds 1.45× the line's median is marked bold. A line that is entirely bold has no reference and stays regular.

OCR also drops bullet glyphs readily, so in the structure pass a line at a list item's text indent continues the item only when the previous line was ≥ 60% of the leaf's width; after a short line it starts a new item.

## 12. Runtimes (`env.ts`, `index.ts`, `node.ts`)

The engine never imports pdf.js or a canvas directly; the entry point installs an `Env` with the pdf.js build, a canvas factory, how to hand tesseract an image, and how to release a canvas. `pdffr` (browser) uses the modern build, DOM canvases and passes canvases to tesseract; `pdffr/node` uses the legacy build, `@napi-rs/canvas`, PNG buffers, and a tesseract cache under the OS temp dir. `bin/pdffr.js` wraps the Node entry.

## 13. What is deliberately not done

- No dictionary, no language model, no word lists. Every decision is geometric so it survives scans, screenshots and languages the author never saw.
- No absolute thresholds in points. Everything is relative to the local size or the leaf's own leading.
- No global "document type" switch. A two-column paper, a Word memo with screenshots, and a scanned invoice run the same code path.

## 14. Known gaps

Radicands, matrices and aligned equation blocks; spanning table cells; outline icons; italic from OCR. See the README.
