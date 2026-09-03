import { describe, expect, it } from 'vitest';
import { buildLines, bulletOf, detectTables, joinRuns, orderRuns } from '../packages/pdffr/src/engine/layout';
import { column, run } from './helpers';

describe('buildLines', () => {
  it('groups runs on one baseline and orders them left to right', () => {
    const lines = buildLines([run('world', 60, 100), run('Hello', 20, 100.4)]);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('Hello world');
  });

  it('keeps distinct baselines apart', () => {
    const lines = buildLines([run('one', 20, 100), run('two', 20, 115)]);
    expect(lines.map((l) => l.text)).toEqual(['one', 'two']);
  });

  it('folds a superscript into the line it overlaps', () => {
    const lines = buildLines([run('Footnote', 20, 100), run('1', 70, 97, 7)]);
    expect(lines).toHaveLength(1);
    expect(lines[0].rich).toBe('Footnote <sup>1</sup>');
  });
});

describe('joinRuns', () => {
  it('emits inline bold and italic markup', () => {
    const size = 11;
    const a = run('Bold', 20, 100, size, { bold: true });
    const b = run('then plain', a.x + a.w + 3, 100, size);
    expect(joinRuns([a, b], size).rich).toBe('**Bold** then plain');
  });

  it('does not insert a space inside a word split across runs', () => {
    const a = run('decom', 20, 100);
    const b = run('piler', a.x + a.w, 100);
    expect(joinRuns([a, b], 11).text).toBe('decompiler');
  });
});

describe('bulletOf', () => {
  it('recognises a Word-style marker glyph followed by a gap', () => {
    const marker = run('•', 72, 100, 11, { font: 'Symbol' });
    const text = run('First point', 90, 100);
    const [line] = buildLines([marker, text]);
    const b = bulletOf(line)!;
    expect(b).not.toBeNull();
    expect(b.ordered).toBe(false);
    expect(b.rich).toBe('First point');
  });

  it('recognises a glued numbered marker', () => {
    const [line] = buildLines([run('2. Second point', 72, 100)]);
    const b = bulletOf(line)!;
    expect(b.ordered).toBe(true);
    expect(b.rich).toBe('Second point');
  });

  it('ignores ordinary prose', () => {
    const [line] = buildLines([run('Plain sentence here', 72, 100)]);
    expect(bulletOf(line)).toBeNull();
  });
});

describe('detectTables', () => {
  it('reconstructs a 3×4 table from aligned cell starts', () => {
    const rows = [
      ['Region', 'Units', 'Change'],
      ['North', '4,210', '+12%'],
      ['South', '3,880', '+9%'],
      ['West', '5,120', '+18%'],
    ];
    const runs = rows.flatMap((r, i) => r.map((c, j) => run(c, 72 + j * 120, 100 + i * 16)));
    const { tables, rest } = detectTables(buildLines(runs));
    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toEqual(rows);
    expect(rest).toHaveLength(0);
  });

  it('never turns a bulleted list into a table', () => {
    const runs = [0, 1, 2].flatMap((i) => [
      run('•', 72, 100 + i * 15, 11, { font: 'Symbol' }),
      run('Item text', 90, 100 + i * 15),
    ]);
    const { tables } = detectTables(buildLines(runs));
    expect(tables).toHaveLength(0);
  });
});

describe('orderRuns', () => {
  it('re-threads a two-column page: all of the left column before the right', () => {
    const left = column(
      Array.from({ length: 8 }, (_, i) => `Left column line ${i} of prose text`),
      72,
      100,
    );
    const right = column(
      Array.from({ length: 8 }, (_, i) => `Right column line ${i} of prose text`),
      330,
      100,
    );
    // interleave to mimic content-stream order
    const runs = left.flatMap((l, i) => [l, right[i]]);
    const leaves = orderRuns(runs);
    const texts = leaves.flatMap((l) => (l.kind === 'lines' ? l.lines.map((x) => x.text) : []));
    expect(texts.slice(0, 8).every((t) => t.startsWith('Left'))).toBe(true);
    expect(texts.slice(8).every((t) => t.startsWith('Right'))).toBe(true);
  });

  it('puts a title that spans both columns first', () => {
    const title = run('A Title Across The Whole Page Width Here', 72, 40, 20);
    const left = column(
      Array.from({ length: 6 }, (_, i) => `Left prose line number ${i}`),
      72,
      100,
    );
    const right = column(
      Array.from({ length: 6 }, (_, i) => `Right prose line number ${i}`),
      330,
      100,
    );
    const leaves = orderRuns([...right, title, ...left]);
    const first = leaves[0];
    expect(first.kind).toBe('lines');
    if (first.kind === 'lines') expect(first.lines[0].text).toMatch(/^A Title/);
  });
});
