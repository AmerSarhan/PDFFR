# langchain-pdffr

[pdffr](https://github.com/AmerSarhan/PDFFR) for Python: local, private **PDF → Markdown** as a LangChain document loader, plus a plain `convert()` for everyone else.

Born-digital pages are decompiled from the file's own glyph geometry in milliseconds — headings, nested lists, tables (ruled or aligned), reading order across columns, math fonts → LaTeX. Scans and screenshots get on-device OCR only where the text layer can't explain the ink. Nothing leaves the machine.

The engine is JavaScript; this package drives the `pdffr` CLI over a subprocess. **Requires Node.js 20+.**

```bash
pip install langchain-pdffr        # add [langchain] for the loader's dependency
```

## LangChain

```python
from langchain_pdffr import PdffrLoader

docs = PdffrLoader("report.pdf").load()
docs[0].page_content   # markdown for page 1
docs[0].metadata       # {'source': 'report.pdf', 'page': 1, 'total_pages': 2, 'ocr_regions': 0}

# whole file as one Document, German OCR, pages 1–3 only
docs = PdffrLoader("scan.pdf", split_pages=False, lang="deu", pages="1-3").load()
```

Because the content is Markdown, `MarkdownHeaderTextSplitter` chunks on real headings and tables survive as tables.

## Without LangChain

```python
from pdffr import convert

r = convert("report.pdf", ocr=True, lang="eng")
r.markdown          # whole document
r.pages[0].markdown # per page
r.pages[0].blocks   # typed blocks: heading | para | list | table | math
r.stats             # pages, nativeDoneMs, totalMs, ocrRegions, …
```

## Speed

The first call resolves `pdffr` through `npx` (a few seconds, then cached). For a fixed install:

```bash
npm install -g pdffr        # then PDFFR_BIN is found on PATH automatically
# or
export PDFFR_BIN=/path/to/pdffr
```

MIT © Amer Sarhan
