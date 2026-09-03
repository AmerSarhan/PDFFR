/**
 * End-to-end on a real PDF, in Node: the native pass only (no canvas, no OCR).
 * report.pdf is born-digital with headings, an inline bold run, a bullet list,
 * a table, a two-column page, and a running header + page numbers.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runPipeline } from '../src/engine/pipeline';
import { setPdfWorkerSrc } from '../src/engine/pdf';
import { blocksToMarkdown } from '../src/engine/markdown';
import type { Block, PipelineEvent } from '../src/engine/types';

const require = createRequire(import.meta.url);
setPdfWorkerSrc(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href);

async function decompileFile(path: string) {
  const buf = await readFile(path);
  const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const pages = new Map<number, Block[]>();
  const traces: string[] = [];
  const emit = (e: PipelineEvent) => {
    if (e.type === 'page') pages.set(e.page, e.blocks);
    if (e.type === 'trace') traces.push(`${e.kind} ${e.msg}`);
  };
  // OCR is disabled: the pool is never touched, so no tesseract worker is created
  await runPipeline(data, emit, { ocr: null as never, escalate: false });
  const markdown = [...pages.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, b]) => blocksToMarkdown(b))
    .join('\n\n');
  return { markdown, traces };
}

describe('report.pdf (born-digital)', () => {
  it('decompiles to the expected markdown', async () => {
    const { markdown, traces } = await decompileFile('demo/public/samples/report.pdf');
    expect(markdown).toContain('# Quarterly Operations Review\n\n## Executive Summary');
    expect(markdown).toContain('**Bold lead-in.** The remainder of this sentence');
    expect(markdown).toContain(
      '- Re-thread reading order across multi-column layouts\n- Reconstruct tables from column alignment\n- Flag scanned pages for OCR instead of guessing',
    );
    expect(markdown).toContain('| Region | Units | Change |\n| --- | --- | --- |\n| North | 4,210 | +12% |');
    // hyphenation repaired across the wrap
    expect(markdown).toContain('This document was produced natively');
    // two columns read left column first, as whole paragraphs
    expect(markdown).toMatch(
      /Left column begins here[^\n]*on purpose\.\n\nRight column text should come after/,
    );
    // running header and page numbers stripped
    expect(markdown).not.toContain('pdffr internal');
    expect(traces.some((t) => t.startsWith('struct stripped'))).toBe(true);
  });
});
