#!/usr/bin/env node
/**
 * pdffr-mcp — an MCP server exposing pdffr's PDF → Markdown decompiler to agents.
 * stdio transport; tools: pdf_to_markdown, pdf_outline, pdf_tables.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { decompile, terminateOcr, type DecompileResult } from 'pdffr/node';

const version = createRequire(import.meta.url)('../package.json').version as string;

const source = {
  path: z.string().optional().describe('Path to a PDF on this machine'),
  url: z.string().url().optional().describe('URL of a PDF to fetch'),
  base64: z.string().optional().describe('Raw PDF bytes, base64-encoded'),
  ocr: z
    .boolean()
    .optional()
    .describe('Escalate ink the text layer cannot explain to on-device OCR (default true)'),
  lang: z
    .string()
    .optional()
    .describe("Tesseract language(s) for OCR, e.g. 'eng', 'deu', 'eng+ara' (default 'eng')"),
};

async function loadBytes(a: { path?: string; url?: string; base64?: string }): Promise<Uint8Array> {
  if (a.path) {
    const b = await readFile(a.path);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }
  if (a.url) {
    const res = await fetch(a.url);
    if (!res.ok) throw new Error(`fetch ${a.url}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  if (a.base64) return new Uint8Array(Buffer.from(a.base64, 'base64'));
  throw new Error('give one of path, url or base64');
}

/** "1-3,7" → Set of page numbers; undefined → all pages */
function pageSet(spec: string | undefined, total: number): Set<number> | null {
  if (!spec) return null;
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`bad page range: ${part}`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let p = Math.max(1, a); p <= Math.min(total, b); p++) out.add(p);
  }
  return out;
}

async function run(a: {
  path?: string;
  url?: string;
  base64?: string;
  ocr?: boolean;
  lang?: string;
}): Promise<DecompileResult> {
  const bytes = await loadBytes(a);
  return decompile(bytes, { ocr: a.ocr ?? true, lang: a.lang });
}

function footer(r: DecompileResult): string {
  const s = r.stats;
  return `\n\n<!-- pdffr: ${s.pages} page(s) · native ${Math.round(s.nativeDoneMs)} ms · total ${Math.round(s.totalMs)} ms · ${s.ocrRegions} OCR region(s) -->`;
}

const server = new McpServer({ name: 'pdffr', version });

server.registerTool(
  'pdf_to_markdown',
  {
    title: 'PDF → Markdown',
    description:
      'Decompile a PDF into Markdown (headings, lists, tables, math as LaTeX) locally. Born-digital pages take milliseconds; scans and screenshots get on-device OCR only where needed. Nothing is uploaded. Use pdf_outline first on long documents to pick pages.',
    inputSchema: {
      ...source,
      pages: z.string().optional().describe("Page selection like '1-3,7' (default all)"),
      maxChars: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Truncate the Markdown to this many characters (default 200000)'),
    },
  },
  async (a) => {
    const r = await run(a);
    const want = pageSet(a.pages, r.stats.pages);
    const pages = want ? r.pages.filter((p) => want.has(p.page)) : r.pages;
    let md = want
      ? pages
          .map((p) => p.markdown)
          .filter(Boolean)
          .join('\n\n')
      : r.markdown;
    const cap = a.maxChars ?? 200_000;
    let note = '';
    if (md.length > cap) {
      md = md.slice(0, cap);
      note = `\n\n<!-- truncated at ${cap} characters; request fewer pages or a larger maxChars -->`;
    }
    return { content: [{ type: 'text', text: md + note + footer(r) }] };
  },
);

server.registerTool(
  'pdf_outline',
  {
    title: 'PDF outline',
    description:
      'List the headings of a PDF with their level and page number, so you can decide which pages to read with pdf_to_markdown.',
    inputSchema: source,
  },
  async (a) => {
    const r = await run(a);
    const lines: string[] = [];
    for (const p of r.pages) {
      for (const b of p.blocks)
        if (b.type === 'heading') lines.push(`${'  '.repeat(b.level - 1)}- ${b.text} (p. ${p.page})`);
    }
    const text = lines.length ? lines.join('\n') : '(no headings found)';
    return { content: [{ type: 'text', text: text + footer(r) }] };
  },
);

server.registerTool(
  'pdf_tables',
  {
    title: 'PDF tables',
    description:
      'Extract every table in a PDF as JSON rows: [{ page, rows: string[][] }]. The first row is the header.',
    inputSchema: source,
  },
  async (a) => {
    const r = await run(a);
    const tables = r.pages.flatMap((p) =>
      p.blocks
        .filter((b) => b.type === 'table')
        .map((b) => ({ page: p.page, rows: (b as { rows: string[][] }).rows })),
    );
    return { content: [{ type: 'text', text: JSON.stringify(tables, null, 2) + footer(r) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await terminateOcr();
    process.exit(0);
  });
}
