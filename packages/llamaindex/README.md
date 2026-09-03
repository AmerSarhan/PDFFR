# pdffr-llamaindex

A [LlamaIndex.TS](https://ts.llamaindex.ai) reader backed by [pdffr](https://github.com/AmerSarhan/PDFFR): each PDF page becomes a `Document` of **Markdown** (headings, lists, tables, math), decompiled from the file's own glyph geometry in milliseconds, with on-device OCR only where a page needs it. Local and private — nothing is uploaded.

```bash
npm install pdffr-llamaindex @llamaindex/core
```

```ts
import { PdffrReader } from 'pdffr-llamaindex';

const reader = new PdffrReader({ lang: 'eng' });
const docs = await reader.loadData('report.pdf');
// docs[i].text     → markdown for page i+1
// docs[i].metadata → { file_path, page, totalPages, ocrRegions, nativeChars }
```

Works with `SimpleDirectoryReader` via `fileExtToReader: { pdf: new PdffrReader() }`. Options: `ocr` (default `true`), `lang`, `splitPages` (default `true`), `concurrency`.

MIT © Amer Sarhan
