"""Runs the real CLI. Set PDFFR_BIN to the repo's packages/pdffr/bin/pdffr.js to test against source."""

from pathlib import Path

import pytest

from pdffr import convert

ROOT = Path(__file__).resolve().parents[3]
REPORT = ROOT / "demo/public/samples/report.pdf"
GAPS = ROOT / "demo/public/samples/gaps.pdf"


def test_convert_returns_pages_and_markdown():
    r = convert(REPORT, ocr=False)
    assert r.stats["pages"] == 2
    assert len(r.pages) == 2
    assert r.markdown.startswith("# Quarterly Operations Review")
    assert "| North | 4,210 | +12% |" in r.pages[0].markdown
    assert any(b["type"] == "table" for b in r.pages[0].blocks)


def test_page_selection():
    r = convert(GAPS, ocr=False, pages="3")
    assert "## Equations" in r.markdown
    assert "## Ruled Table" not in r.markdown


def test_langchain_loader():
    pytest.importorskip("langchain_core")
    from langchain_pdffr import PdffrLoader

    docs = PdffrLoader(REPORT, ocr=False).load()
    assert len(docs) == 2
    assert docs[0].metadata["page"] == 1
    assert docs[0].metadata["total_pages"] == 2
    assert "## Executive Summary" in docs[0].page_content

    (whole,) = PdffrLoader(REPORT, ocr=False, split_pages=False).load()
    assert "## Two-Column Analysis" in whole.page_content
