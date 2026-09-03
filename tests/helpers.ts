import type { Run } from '../packages/pdffr/src/engine/types';

/** Build a native run the way pdf.js extraction would: top-left origin, y downward. */
export function run(text: string, x: number, y: number, size = 11, extra: Partial<Run> = {}): Run {
  return {
    text,
    x,
    y,
    w: text.length * size * 0.5,
    h: size * 1.15,
    size,
    bold: false,
    italic: false,
    conf: 100,
    src: 'native',
    ...extra,
  };
}

/** Lay out lines of prose top-to-bottom in one column. */
export function column(lines: string[], x: number, yTop: number, size = 11, leading = 15): Run[] {
  return lines.map((t, i) => run(t, x, yTop + i * leading, size));
}

/** Like `column`, but each line is laid out as separate word runs the way pdf.js delivers real prose. */
export function wordsColumn(lines: string[], x: number, yTop: number, size = 11, leading = 15): Run[] {
  const out: Run[] = [];
  lines.forEach((line, i) => {
    let cx = x;
    for (const w of line.split(' ')) {
      const r = run(w, cx, yTop + i * leading, size);
      out.push(r);
      cx += r.w + size * 0.25;
    }
  });
  return out;
}
