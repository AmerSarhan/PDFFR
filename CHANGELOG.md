# Changelog

## 0.1.0 — unreleased

Initial release.

- Geometry-native decompilation of born-digital pages: lines, XY-cut reading order, headings by size clustering, nested lists from marker glyphs and indent, tables from column alignment, inline bold/italic/superscript, hyphenation repair, running header/footer stripping.
- Render-diff oracle: exact bitmap rectangles from the content stream plus the raster's residual ink, so OCR only ever sees pixels the text layer cannot explain.
- On-device OCR pool (tesseract.js) with upsampling for small crops, second reads of doubtful words, and a text-plausibility gate that rejects icons and charts regardless of reported confidence.
- Streaming pipeline: concurrent native pass, placeholders for pending regions, in-place replacement as OCR completes; whole-page scans split along their own ink for parallel OCR.
- Public API: `decompile()`, `warmOcr()`, `runPipeline()`, `blocksToMarkdown()`, `setPdfWorkerSrc()`.
