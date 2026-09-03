import { describe, expect, it } from 'vitest';
import { buildLines, joinRuns, orderRuns } from '../packages/pdffr/src/engine/layout';
import { bodySize, toBlocks } from '../packages/pdffr/src/engine/structure';
import { blocksToMarkdown, joinPages } from '../packages/pdffr/src/engine/markdown';
import type { Run } from '../packages/pdffr/src/engine/types';
import { run, wordsColumn } from './helpers';

function decompile(runs: Run[], rules?: Parameters<typeof orderRuns>[1]) {
  const leaves = orderRuns(runs, rules);
  return toBlocks(leaves, bodySize(buildLines(runs)), 792, new Set(), false);
}

/** Lay glyphs out one after another with a given gap between them. */
function tracked(glyphs: string[], x: number, y: number, size: number, gaps: number[]): Run[] {
  const out: Run[] = [];
  let cx = x;
  glyphs.forEach((g, i) => {
    const r = run(g, cx, y, size);
    out.push(r);
    cx += r.w + (gaps[i] ?? gaps[gaps.length - 1]);
  });
  return out;
}

describe('letter-spaced text', () => {
  it('joins tracked glyphs and breaks words only at a clearly larger gap', () => {
    const size = 9;
    const glyphs = [...'BUSINESS', ...'DEV'];
    const gaps = [...Array(7).fill(size * 0.35), size * 1.0, size * 0.35, size * 0.35];
    const runs = tracked(glyphs, 72, 100, size, gaps);
    expect(joinRuns(runs, size).text).toBe('BUSINESS DEV');
  });
});

describe('label column', () => {
  it('turns a narrow label beside prose into a heading over that prose', () => {
    const label = [run('KSA-UAE tension', 72, 100, 10, { bold: true })];
    const prose = wordsColumn(
      Array.from({ length: 9 }, (_, i) => `Prose line number ${i} of the paragraph beside the label`),
      200,
      100,
      10,
      13,
    );
    const md = blocksToMarkdown(decompile([...prose, ...label]));
    expect(md.startsWith('### KSA-UAE tension\n\nProse line number 0')).toBe(true);
  });

  it('does not cut a table into columns just because it has a gutter', () => {
    const rows = ['Region', 'North', 'South', 'West', 'East', 'Centre'];
    const runs = rows.flatMap((r, i) => [
      run(r, 72, 100 + i * 14),
      run('4,210', 200, 100 + i * 14),
      run('+12%', 330, 100 + i * 14),
    ]);
    const leaves = orderRuns(runs);
    expect(leaves.some((l) => l.kind === 'table')).toBe(true);
  });
});

describe('page joins', () => {
  it('stitches a paragraph cut by a page break and leaves finished pages alone', () => {
    expect(joinPages(['reassigned to Al Bayda after unification,', 'reflects unresolved tensions.'])).toBe(
      'reassigned to Al Bayda after unification, reflects unresolved tensions.',
    );
    expect(joinPages(['# Title', 'Next page starts here.'])).toBe('# Title\n\nNext page starts here.');
  });
});

describe('inline markup', () => {
  it('never wraps bare punctuation in bold', () => {
    const a = run('goods', 72, 100);
    const dot = run('.', a.x + a.w, 100, 11, { bold: true });
    expect(joinRuns([a, dot], 11).rich).toBe('goods.');
  });
});

describe('fractions', () => {
  it('folds a rule with math above and below into \\frac', () => {
    const num = run('a', 100, 92, 12, { math: true, font: 'CMMI12' });
    const den = run('b', 100, 112, 12, { math: true, font: 'CMMI12' });
    const eq = run('=', 130, 102, 12, { math: true, font: 'CMR12' });
    const c = run('c', 142, 102, 12, { math: true, font: 'CMMI12' });
    const rules = { h: [{ y: 110, x0: 98, x1: 108 }], v: [] };
    const blocks = decompile([num, den, eq, c], rules);
    expect(blocks[0]).toEqual({ type: 'math', latex: '\\frac{a}{b} = c' });
  });
});

describe('lists after OCR', () => {
  it('starts a new item after a short line even when the marker glyph was lost', () => {
    const runs = [
      run('•', 72, 100, 11, { font: 'Symbol' }),
      run('Short item', 90, 100),
      run('Another item whose bullet OCR dropped', 90, 115),
      run('•', 72, 130, 11, { font: 'Symbol' }),
      run('Third item', 90, 130),
    ];
    const md = blocksToMarkdown(decompile(runs));
    expect(md).toBe('- Short item\n- Another item whose bullet OCR dropped\n- Third item');
  });
});
