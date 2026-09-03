import { describe, expect, it } from 'vitest';
import { buildLines, orderRuns } from '../src/engine/layout';
import { bodySize, computeDropSet, toBlocks } from '../src/engine/structure';
import { blocksToMarkdown } from '../src/engine/markdown';
import type { Run } from '../src/engine/types';
import { column, run } from './helpers';

function decompile(runs: Run[], pageH = 792, multiPage = false, drop = new Set<string>()) {
  const leaves = orderRuns(runs);
  const body = bodySize(buildLines(runs));
  return toBlocks(leaves, body, pageH, drop, multiPage);
}

describe('headings', () => {
  it('levels headings by size ratio against the body size', () => {
    const runs = [
      run('Document Title', 72, 60, 24),
      run('Section', 72, 110, 16),
      run('Subsection', 72, 150, 13),
      ...column(['Body text line one that is long enough', 'body text line two continues here'], 72, 180),
    ];
    const blocks = decompile(runs);
    expect(blocks.slice(0, 3)).toEqual([
      { type: 'heading', level: 1, text: 'Document Title' },
      { type: 'heading', level: 2, text: 'Section' },
      { type: 'heading', level: 3, text: 'Subsection' },
    ]);
  });

  it('treats an isolated bold line at body size as a minor heading', () => {
    const runs = [
      run('Key Actions', 72, 100, 11, { bold: true }),
      ...column(['Regular paragraph text follows the heading', 'and wraps onto a second line here'], 72, 125),
    ];
    const blocks = decompile(runs);
    expect(blocks[0]).toEqual({ type: 'heading', level: 3, text: 'Key Actions' });
  });
});

describe('paragraphs', () => {
  it('joins wrapped lines and breaks on a larger leading', () => {
    const runs = [
      ...column(['First paragraph starts here and', 'wraps to a second line.'], 72, 100),
      ...column(['Second paragraph after a gap that', 'is clearly larger than the leading.'], 72, 145),
    ];
    const blocks = decompile(runs);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      type: 'para',
      text: 'First paragraph starts here and wraps to a second line.',
    });
  });

  it('repairs soft hyphenation but keeps real prefix hyphens', () => {
    const a = decompile(column(['This is a docu-', 'ment about text.'], 72, 100));
    expect(a[0]).toEqual({ type: 'para', text: 'This is a document about text.' });
    const b = decompile(column(['We must re-', 'thread the order.'], 72, 100));
    expect(b[0]).toEqual({ type: 'para', text: 'We must re-thread the order.' });
  });
});

describe('lists', () => {
  it('nests items by marker indent and wraps continuations', () => {
    const runs = [
      run('•', 72, 100, 11, { font: 'Symbol' }),
      run('Top level item', 90, 100),
      run('o', 108, 115, 11, { font: 'CourierNewPSMT' }),
      run('Nested item that wraps', 126, 115),
      run('onto another line', 126, 130),
      run('•', 72, 145, 11, { font: 'Symbol' }),
      run('Back to top level', 90, 145),
    ];
    const blocks = decompile(runs);
    expect(blocks).toHaveLength(1);
    expect(blocksToMarkdown(blocks)).toBe(
      ['- Top level item', '  - Nested item that wraps onto another line', '- Back to top level'].join('\n'),
    );
  });

  it('drops a marker glyph that sits alone because its content was a figure', () => {
    const runs = [run('o', 108, 100, 11, { font: 'CourierNewPSMT' }), run('Real text after', 72, 130)];
    const blocks = decompile(runs);
    expect(blocks).toEqual([{ type: 'para', text: 'Real text after' }]);
  });
});

describe('page furniture', () => {
  it('strips running headers, footers and page numbers that recur across pages', () => {
    const page = (n: number) => ({
      lines: buildLines([
        run('ACME Corp · Annual Report', 72, 30, 9),
        ...column(['Body paragraph text for the page', 'which continues on a second line.'], 72, 200),
        run(String(n), 540, 760, 9),
      ]),
      height: 792,
    });
    const drop = computeDropSet([page(1), page(2), page(3)]);
    expect(drop.has('acme corp · annual report')).toBe(true);
    const blocks = decompile(
      [
        run('ACME Corp · Annual Report', 72, 30, 9),
        ...column(['Body paragraph text for the page', 'which continues on a second line.'], 72, 200),
        run('2', 540, 760, 9),
      ],
      792,
      true,
      drop,
    );
    expect(blocks).toEqual([
      { type: 'para', text: 'Body paragraph text for the page which continues on a second line.' },
    ]);
  });
});

describe('markdown', () => {
  it('escapes pipes in table cells and pads ragged rows', () => {
    const md = blocksToMarkdown([{ type: 'table', rows: [['a', 'b|c'], ['d']] }]);
    expect(md).toBe('| a | b\\|c |\n| --- | --- |\n| d |  |');
  });
});
