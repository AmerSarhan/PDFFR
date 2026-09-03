# pdffr-langchain

A [LangChain.js](https://js.langchain.com) document loader backed by [pdffr](https://github.com/AmerSarhan/PDFFR): each PDF page becomes a `Document` of **Markdown** (headings, lists, tables, math), decompiled from the file's own glyph geometry in milliseconds, with on-device OCR only where a page needs it. Local and private — nothing is uploaded.

```bash
npm install pdffr-langchain @langchain/core
```

```ts
import { PdffrLoader } from 'pdffr-langchain';

const loader = new PdffrLoader('report.pdf', { lang: 'eng' });
const docs = await loader.load();
// docs[i].pageContent → markdown for page i+1
// docs[i].metadata    → { source, page, totalPages, ocrRegions, nativeChars }

// or one Document for the whole file
const [doc] = await new PdffrLoader('report.pdf', { splitPages: false }).load();
```

Also accepts a `Blob`/`File` or a `Uint8Array` instead of a path. Options: `ocr` (default `true`), `lang`, `splitPages` (default `true`), `concurrency`.

Because the output is Markdown, downstream splitters can chunk on headings (`MarkdownTextSplitter`) and tables survive as tables.

MIT © Amer Sarhan
