"""LangChain document loader backed by pdffr (local PDF → Markdown)."""

from __future__ import annotations

from typing import Iterator, Optional, Union
import os

from langchain_core.document_loaders import BaseLoader
from langchain_core.documents import Document

from pdffr import convert

__all__ = ["PdffrLoader"]


class PdffrLoader(BaseLoader):
    """Load a PDF as Markdown ``Document`` objects, one per page (or one for the file).

    Born-digital pages are decompiled from glyph geometry in milliseconds; scans and
    screenshots get on-device OCR only where the text layer can't explain the ink.
    Nothing leaves the machine. Requires Node.js 20+ (the engine is JavaScript).

    Example:
        >>> loader = PdffrLoader("report.pdf", lang="eng")
        >>> docs = loader.load()
        >>> docs[0].metadata
        {'source': 'report.pdf', 'page': 1, 'total_pages': 2, 'ocr_regions': 0}
    """

    def __init__(
        self,
        file_path: Union[str, "os.PathLike[str]"],
        *,
        ocr: bool = True,
        lang: str = "eng",
        pages: Optional[str] = None,
        split_pages: bool = True,
    ) -> None:
        self.file_path = str(file_path)
        self.ocr = ocr
        self.lang = lang
        self.pages = pages
        self.split_pages = split_pages

    def lazy_load(self) -> Iterator[Document]:
        result = convert(self.file_path, ocr=self.ocr, lang=self.lang, pages=self.pages)
        base = {"source": self.file_path, "total_pages": result.stats.get("pages")}
        if not self.split_pages:
            yield Document(
                page_content=result.markdown,
                metadata={**base, "ocr_regions": result.stats.get("ocrRegions", 0)},
            )
            return
        for p in result.pages:
            if not p.markdown:
                continue
            yield Document(
                page_content=p.markdown,
                metadata={
                    **base,
                    "page": p.page,
                    "ocr_regions": sum(1 for b in p.blocks if b.get("type") == "pending"),
                },
            )
