# Contributing

Thanks for looking. pdffr is small enough to hold in your head; this page tells you where things are and how to change them without breaking the other documents.

## Setup

```bash
npm install
npm run dev        # demo on http://localhost:5173
npm test           # vitest: unit tests + Node end-to-end runs on the sample PDFs
npm run typecheck
npm run build      # library (dist/) and demo (dist-demo/)
```

## Layout of the code

| Path                                          | What it does                                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `src/engine/env.ts`                           | runtime abstraction (pdf.js build, canvas factory) installed by `src/index.ts` / `src/node.ts`                                        |
| `src/engine/pdf.ts`                           | pdf.js boundary: text layer → runs (with rotation and math flags), CTM-tracked image rectangles and ruling lines, rendering, cropping |
| `src/engine/oracle.ts`                        | render-diff oracle: ink mask − native glyph boxes → regions that need OCR                                                             |
| `src/engine/ocr.ts`                           | tesseract worker pool, second reads of doubtful words, text-plausibility gate                                                         |
| `src/engine/layout.ts`                        | runs → lines, bullet detection, table detection, XY-cut reading order                                                                 |
| `src/engine/structure.ts`                     | ordered leaves → typed blocks (headings, lists, paragraphs, tables), furniture stripping                                              |
| `src/engine/markdown.ts`                      | blocks → markdown text                                                                                                                |
| `src/engine/pipeline.ts`                      | orchestration: concurrent native pass, escalation, streaming events                                                                   |
| `src/core.ts`                                 | public API (runtime-agnostic)                                                                                                         |
| `src/index.ts`, `src/node.ts`, `bin/pdffr.js` | browser entry, Node entry, CLI                                                                                                        |
| `demo/`                                       | the playground app                                                                                                                    |
| `docs/architecture.md`                        | the reasoning behind every heuristic and threshold                                                                                    |

## The one rule

**Every heuristic must be justified by geometry the reader could see.** If a change makes one document better by special-casing its content (a word list, a magic string), it is the wrong change. Thresholds are expressed relative to the local font size or the leaf's own leading, never in absolute points, so they hold across scans, screenshots and 6pt footnotes alike.

## Adding a test

Unit tests build runs with `tests/helpers.ts` and assert on lines, leaves or blocks — see `tests/layout.test.ts`. If you fix a bug found on a real PDF, add a minimal synthetic reproduction rather than the PDF itself; keep `demo/public/samples/` to the four canonical documents.

## Sending a change

1. `npm test && npm run typecheck && npm run format:check`
2. Describe the geometry the change addresses and which sample documents you ran it against.
3. If a threshold moved, say why in `docs/architecture.md`.
