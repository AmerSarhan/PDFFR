import type { Run } from '../src/engine/types';

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
