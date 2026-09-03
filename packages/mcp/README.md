# pdffr-mcp

An [MCP](https://modelcontextprotocol.io) server that gives any agent — Claude Desktop, Claude Code, Cursor, Windsurf, Zed, your own — a local, private **PDF → Markdown** tool backed by [pdffr](https://github.com/AmerSarhan/PDFFR). Born-digital pages decompile from glyph geometry in milliseconds; scans and screenshots get on-device OCR only where the text layer can't explain the ink. Nothing leaves the machine.

## Install

Claude Desktop / Claude Code / Cursor / Windsurf — add to your MCP config:

```json
{
  "mcpServers": {
    "pdffr": {
      "command": "npx",
      "args": ["-y", "pdffr-mcp"]
    }
  }
}
```

Claude Code one-liner:

```bash
claude mcp add pdffr -- npx -y pdffr-mcp
```

Requires Node 20+. The first run downloads the OCR model for the requested language (English by default) into the OS temp directory.

## Tools

### `pdf_to_markdown`

Decompile a PDF to Markdown. Give it one of `path`, `url` or `base64`.

| Argument   | Type    | Notes                                                               |
| ---------- | ------- | ------------------------------------------------------------------- |
| `path`     | string  | absolute or relative file path                                      |
| `url`      | string  | fetched with the server's network access                            |
| `base64`   | string  | raw PDF bytes                                                       |
| `pages`    | string  | e.g. `"1-3,7"`; default all                                         |
| `ocr`      | boolean | escalate unexplained ink to OCR (default `true`)                    |
| `lang`     | string  | tesseract language(s), e.g. `"deu"`, `"eng+ara"` (default `"eng"`)  |
| `maxChars` | number  | truncate the result (default 200 000) — the response says if it did |

Returns the Markdown, followed by a one-line stats footer (pages, time, OCR regions).

### `pdf_outline`

Headings only — level, text and page — so an agent can decide which pages to read before paying for them. Same inputs (`path` / `url` / `base64`, `ocr`, `lang`).

### `pdf_tables`

Every table as JSON rows (`[{ page, rows: string[][] }]`). Same inputs.

## Why not a vision model

A PDF already knows where every glyph is. pdffr reads that geometry directly and reserves OCR for the pixels the text layer doesn't explain, so a 30-page report comes back in well under a second and a scanned invoice in a couple of seconds — with no API key and no upload. See the [architecture notes](https://github.com/AmerSarhan/PDFFR/blob/main/docs/architecture.md).

MIT © Amer Sarhan
