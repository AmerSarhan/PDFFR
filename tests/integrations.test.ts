/**
 * The integration packages against the built library (dist/) and, for the MCP server,
 * against its own built output — `npm test` builds both first.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PdffrLoader } from '../packages/langchain/src/index';
import { PdffrReader } from '../packages/llamaindex/src/index';

const REPORT = 'demo/public/samples/report.pdf';
const GAPS = 'demo/public/samples/gaps.pdf';

describe('pdffr-langchain', () => {
  it('loads one markdown Document per page with page metadata', async () => {
    const docs = await new PdffrLoader(REPORT, { ocr: false }).load();
    expect(docs).toHaveLength(2);
    expect(docs[0].pageContent).toContain('# Quarterly Operations Review');
    expect(docs[0].metadata).toMatchObject({ source: REPORT, page: 1, totalPages: 2 });
    expect(docs[1].pageContent).toContain('## Two-Column Analysis');
  });

  it('can return the whole file as one Document', async () => {
    const [doc] = await new PdffrLoader(REPORT, { ocr: false, splitPages: false }).load();
    expect(doc.pageContent).toContain('# Quarterly Operations Review');
    expect(doc.pageContent).toContain('## Two-Column Analysis');
  });
});

describe('pdffr-llamaindex', () => {
  it('reads one markdown Document per page', async () => {
    const docs = await new PdffrReader({ ocr: false }).loadData(GAPS);
    expect(docs).toHaveLength(3);
    expect(docs[0].text).toContain('| Item | Description | Amount |');
    expect(docs[2].text).toContain('\\sum x_{i}^{2}');
    expect(docs[0].metadata).toMatchObject({ page: 1, totalPages: 3 });
    expect(String(docs[0].metadata.file_path)).toMatch(/gaps\.pdf$/);
  });
});

describe('pdffr-mcp', () => {
  it('serves pdf_outline, pdf_tables and pdf_to_markdown over stdio', async () => {
    const transport = new StdioClientTransport({ command: 'node', args: ['packages/mcp/dist/index.js'] });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(['pdf_outline', 'pdf_tables', 'pdf_to_markdown']);

      const outline = await client.callTool({ name: 'pdf_outline', arguments: { path: GAPS, ocr: false } });
      const outlineText = (outline.content as { type: string; text: string }[])[0].text;
      expect(outlineText).toContain('- Ruled Table (p. 1)');
      expect(outlineText).toContain('- Equations (p. 3)');

      const tables = await client.callTool({ name: 'pdf_tables', arguments: { path: GAPS, ocr: false } });
      const parsed = JSON.parse((tables.content as { text: string }[])[0].text.split('\n\n<!--')[0]);
      expect(parsed[0]).toMatchObject({ page: 1 });
      expect(parsed[0].rows[0]).toEqual(['Item', 'Description', 'Amount']);

      const md = await client.callTool({
        name: 'pdf_to_markdown',
        arguments: { path: GAPS, ocr: false, pages: '3' },
      });
      const mdText = (md.content as { text: string }[])[0].text;
      expect(mdText).toContain('## Equations');
      expect(mdText).not.toContain('## Ruled Table');
      expect(mdText).toContain('<!-- pdffr: 3 page(s)');
    } finally {
      await client.close();
    }
  }, 60_000);
});
