/**
 * End-to-end on real PDFs through the Node entry (legacy pdf.js, no OCR):
 * report.pdf   — headings, an inline bold run, a bullet list, a table, a two-column page, running header + page numbers
 * gaps.pdf     — a ruled table with a multi-line cell, a rotated sidebar, inline and display math
 */
import { describe, expect, it } from 'vitest';
import { decompileFile } from '../packages/pdffr/src/node';

describe('report.pdf (born-digital)', () => {
  it('decompiles to the expected markdown', async () => {
    const traces: string[] = [];
    const { markdown } = await decompileFile('demo/public/samples/report.pdf', {
      ocr: false,
      onEvent: (e) => e.type === 'trace' && traces.push(`${e.kind} ${e.msg}`),
    });
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

describe('gaps.pdf (ruled table, rotation, math)', () => {
  it('reconstructs a ruled table with a multi-line cell from its lines', async () => {
    const { pages } = await decompileFile('demo/public/samples/gaps.pdf', { ocr: false });
    const md = pages[0].markdown;
    expect(md).toContain('## Ruled Table');
    expect(md).toContain('| Item | Description | Amount |');
    expect(md).toContain('| Widget A | Anodized aluminium, boxed in sets of ten | 1,250.00 |');
    expect(md).toContain('| Widget B | Plain steel | 980.00 |');
    expect(md).toContain('Text after the table continues normally.');
  });

  it('re-frames a rotated sidebar and keeps it out of the upright flow', async () => {
    const { pages } = await decompileFile('demo/public/samples/gaps.pdf', { ocr: false });
    const md = pages[1].markdown;
    expect(md).toMatch(
      /Upright paragraph text sits here and reads normally across the page\. It continues for a second line of upright text\./,
    );
    expect(md).toContain('CONFIDENTIAL DRAFT ROTATED SIDEBAR second rotated line of the sidebar');
    expect(md.indexOf('Upright')).toBeLessThan(md.indexOf('CONFIDENTIAL'));
  });

  it('transliterates math fonts and scripts to LaTeX', async () => {
    const { pages } = await decompileFile('demo/public/samples/gaps.pdf', { ocr: false });
    const md = pages[2].markdown;
    expect(md).toContain('E = mc<sup>2</sup>');
    expect(md).toContain('the angle $\\theta$ is small.');
    expect(md).toContain('$$\n\\sum x_{i}^{2} = \\pi + \\alpha \\beta\n$$');
  });
});
