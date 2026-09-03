# Changelog

## 0.2.0 — 2026-09-03

- Letter-spaced (tracked) headings join correctly instead of one word per glyph.
- Gutter cuts now recognise three geometric signatures — prose columns, label columns (labels become headings over their paragraphs) and card lanes (lines that do not share baselines) — and never cut a table.
- Fractions drawn with a bar fold into `\\frac{}{}`; consecutive display equations merge into one block; an italic letter carrying a script is math even in a text font; a lone `×` in a text font is not.
- Paragraphs cut by a page break are stitched back together (`joinPages`).
- Bold is recovered from OCR stroke weight; a list item after a short line is a new item even when OCR lost its bullet.
- Bare punctuation never carries inline markup.
- Live demo on GitHub Pages; README hero; Node entry and CLI verified from the registry.

## 0.1.0 — 2026-09-03

Initial release.

- Geometry-native decompilation of born-digital pages: lines, XY-cut reading order, headings by size clustering, nested lists from marker glyphs and indent, tables from column alignment, inline bold/italic/superscript, hyphenation repair, running header/footer stripping.
- Render-diff oracle: exact bitmap rectangles from the content stream plus the raster's residual ink, so OCR only ever sees pixels the text layer cannot explain.
- On-device OCR pool (tesseract.js) with upsampling for small crops, second reads of doubtful words, and a text-plausibility gate that rejects icons and charts regardless of reported confidence.
- Streaming pipeline: concurrent native pass, placeholders for pending regions, in-place replacement as OCR completes; whole-page scans split along their own ink for parallel OCR.
- Ruled tables reconstructed from the content stream's line segments (CTM-tracked), including multi-line cells and cells without aligned starts.
- Rotated text: pages turned by 90/180/270° are read upright; rotated sidebars become their own groups; skewed watermarks are dropped.
- Math: runs in math fonts and their sub/superscripts become `$…$` / `$$…$$` LaTeX (Greek, operators, `\sum`, scripts).
- OCR in any tesseract language (`lang` option, demo selector); the plausibility gate is Unicode-aware, and icons that OCR into characters are rejected by ink density and colour relative to their line.
- Node runtime (`pdffr/node`, `@napi-rs/canvas`) and a `pdffr` CLI.
- Public API: `decompile()`, `decompileFile()` (Node), `warmOcr()`, `terminateOcr()`, `runPipeline()`, `blocksToMarkdown()`, `setPdfWorkerSrc()`.
