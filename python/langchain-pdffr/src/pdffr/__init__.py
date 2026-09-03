"""pdffr for Python: local PDF → Markdown through the pdffr CLI (Node.js).

The engine is JavaScript; this module drives it over a subprocess and parses its
``--json`` output. Requires Node 20+. The first call may take a few seconds while
``npx`` resolves ``pdffr``; set ``PDFFR_BIN`` to a local ``pdffr`` executable to skip that.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Union

__all__ = ["Page", "Result", "convert", "PdffrError", "PDFFR_VERSION"]

#: Minimum pdffr CLI version with ``--json`` support.
PDFFR_VERSION = "0.3.1"


class PdffrError(RuntimeError):
    """The pdffr CLI could not run or returned an error."""


@dataclass
class Page:
    page: int
    markdown: str
    blocks: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class Result:
    file: str
    markdown: str
    pages: List[Page]
    stats: Dict[str, Any]


def _command() -> List[str]:
    override = os.environ.get("PDFFR_BIN")
    if override:
        return [override]
    local = shutil.which("pdffr")
    if local:
        return [local]
    npx = shutil.which("npx")
    if not npx:
        raise PdffrError(
            "pdffr needs Node.js 20+ (npx not found). Install Node, or set PDFFR_BIN to a pdffr executable."
        )
    return [npx, "-y", "-p", f"pdffr@^{PDFFR_VERSION}", "pdffr"]


def convert(
    path: Union[str, "os.PathLike[str]"],
    *,
    ocr: bool = True,
    lang: str = "eng",
    pages: Optional[str] = None,
    timeout: Optional[float] = 600,
    extra_args: Sequence[str] = (),
) -> Result:
    """Decompile a PDF to Markdown.

    Args:
        path: the PDF file.
        ocr: escalate ink the text layer cannot explain to on-device OCR (default True).
        lang: tesseract language(s), e.g. ``"eng"``, ``"deu"``, ``"eng+ara"``.
        pages: page selection like ``"1-3,7"``; default all.
        timeout: seconds before the subprocess is killed.
        extra_args: extra CLI flags.

    Returns:
        A :class:`Result` with the whole-document Markdown, per-page Markdown and blocks, and stats.
    """
    file = str(Path(path))
    args = _command() + [file, "--json", "-q", "--lang", lang, *extra_args]
    if not ocr:
        args.append("--no-ocr")
    if pages:
        args += ["--pages", pages]
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    except FileNotFoundError as e:  # pragma: no cover - depends on the host
        raise PdffrError(f"could not start pdffr: {e}") from e
    if proc.returncode != 0:
        raise PdffrError(proc.stderr.strip() or f"pdffr exited with {proc.returncode}")
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        raise PdffrError(f"unexpected pdffr output: {proc.stdout[:200]!r}") from e
    return Result(
        file=data.get("file", file),
        markdown=data["markdown"],
        pages=[Page(page=p["page"], markdown=p["markdown"], blocks=p.get("blocks", [])) for p in data["pages"]],
        stats=data.get("stats", {}),
    )
