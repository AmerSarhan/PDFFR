import type { Leaf, Line, Run, Table } from './types';

/* ---------- small helpers ---------- */
export function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}

function esc(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

/* ---------- runs → lines ---------- */

/** Group runs sharing a baseline band into lines, sorted top-to-bottom. */
export function buildLines(runs: Run[]): Line[] {
  const rs = runs.filter((r) => r.text.trim()).sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x);
  const lines: { runs: Run[]; yc: number; h: number }[] = [];
  for (const r of rs) {
    const yc = r.y + r.h / 2;
    let best: (typeof lines)[number] | null = null;
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 6; i--) {
      const ln = lines[i];
      if (Math.abs(yc - ln.yc) < Math.min(r.h, ln.h) * 0.55) {
        best = ln;
        break;
      }
      // a superscript/subscript is much smaller and merely overlaps the line's box
      const lnTop = ln.yc - ln.h / 2;
      const lnBot = ln.yc + ln.h / 2;
      if (r.h < ln.h * 0.75 && r.y < lnBot && r.y + r.h > lnTop) {
        best = ln;
        break;
      }
    }
    if (best) {
      best.runs.push(r);
      const n = best.runs.length;
      best.yc = (best.yc * (n - 1) + yc) / n;
      best.h = Math.max(best.h, r.h);
    } else lines.push({ runs: [r], yc, h: r.h });
  }
  return lines.map((ln) => finishLine(ln.runs));
}

function finishLine(runs: Run[]): Line {
  runs.sort((a, b) => a.x - b.x);
  const x0 = runs[0].x;
  const x1 = Math.max(...runs.map((r) => r.x + r.w));
  const y0 = Math.min(...runs.map((r) => r.y));
  const y1 = Math.max(...runs.map((r) => r.y + r.h));
  const sizes: number[] = [];
  for (const r of runs) for (let i = 0; i < Math.max(1, r.text.trim().length); i++) sizes.push(r.size);
  const size = median(sizes);
  const boldChars = runs.filter((r) => r.bold).reduce((a, r) => a + r.text.trim().length, 0);
  const totalChars = runs.reduce((a, r) => a + r.text.trim().length, 0);
  const { text, rich } = joinRuns(runs, size);
  return { runs, x0, x1, y0, y1, y: (y0 + y1) / 2, size, text, rich, bold: totalChars > 0 && boldChars / totalChars >= 0.8 };
}

/** Join runs left→right, inserting spaces across gaps and emitting inline markdown for style changes. */
export function joinRuns(runs: Run[], lineSize: number): { text: string; rich: string } {
  type Seg = { text: string; bold: boolean; italic: boolean; sup: boolean };
  const segs: Seg[] = [];
  const bottom = runs.reduce((a, q) => Math.max(a, q.y + q.h), 0);
  let prev: Run | null = null;
  let plain = '';
  for (const r of runs) {
    const t = r.text.trim();
    if (!t) continue;
    const sup = r.size < lineSize * 0.72 && r.y + r.h < bottom - lineSize * 0.28;
    let sep = '';
    if (prev) {
      const gap = r.x - (prev.x + prev.w);
      if (gap > lineSize * 0.22 || /\s$/.test(prev.text) || /^\s/.test(r.text)) sep = ' ';
      else if (gap > lineSize * 0.06 && !/[-(\[/]$/.test(prev.text) && !/^[.,;:)\]]/.test(r.text)) sep = ' ';
    }
    plain += sep + t;
    const last = segs[segs.length - 1];
    if (last && last.bold === r.bold && last.italic === r.italic && last.sup === sup) last.text += sep + t;
    else segs.push({ text: (segs.length ? sep : '') + t, bold: r.bold, italic: r.italic, sup });
    prev = r;
  }
  let rich = '';
  for (const s of segs) {
    const lead = s.text.match(/^\s*/)![0];
    let body = s.text.slice(lead.length);
    if (!body) continue;
    body = esc(body);
    if (s.sup) body = `<sup>${body}</sup>`;
    else if (s.bold && s.italic) body = `***${body}***`;
    else if (s.bold) body = `**${body}**`;
    else if (s.italic) body = `*${body}*`;
    rich += lead + body;
  }
  return { text: plain.replace(/\s+/g, ' ').trim(), rich: rich.replace(/\s+/g, ' ').trim() };
}

/* ---------- bullets ---------- */

const BULLET_FONT = /symbol|wingding|webding|zapf|dingbat|courier/i;
const BULLET_CHARS = /^[•‣◦▪▫■□●○·\-–—*§¾✓✔➢➤►▶o]$/;
const GLUED_BULLET = /^([•‣◦▪▫■□●○·\-–—*]|\(?\d{1,3}[.)]|\(?[a-z][.)]|\(?[ivx]{1,5}[.)])\s+(.*)/i;
const ORDERED_MARKER = /^(\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]|\(?[ivxIVX]{1,5}[.)])$/;

export interface Bullet {
  marker: string;
  ordered: boolean;
  /** x where the item text starts */
  textX: number;
  /** item text with inline markup, marker removed */
  rich: string;
}

/** Is this line a list item? Handles Word-style marker glyphs (own run + gap) and glued "1. text". */
export function bulletOf(ln: Line): Bullet | null {
  const r0 = ln.runs[0];
  const t0 = r0.text.trim();
  if (ln.runs.length > 1 && t0.length <= 4) {
    const r1 = ln.runs[1];
    const gap = r1.x - (r0.x + r0.w);
    const symbolFont = BULLET_FONT.test(r0.font || '');
    if (gap > ln.size * 0.35 || symbolFont) {
      const isGlyph = t0.length === 1 && (BULLET_CHARS.test(t0) || !/[A-Za-z0-9]/.test(t0) || symbolFont);
      if (isGlyph) return { marker: t0, ordered: false, textX: r1.x, rich: joinRuns(ln.runs.slice(1), ln.size).rich };
      if (ORDERED_MARKER.test(t0)) return { marker: t0, ordered: true, textX: r1.x, rich: joinRuns(ln.runs.slice(1), ln.size).rich };
    }
  }
  const m = ln.rich.match(GLUED_BULLET);
  if (m) {
    const ordered = /\d|[a-z]/i.test(m[1]) && !/^[•‣◦▪▫■□●○·\-–—*]$/.test(m[1]);
    return { marker: m[1], ordered, textX: ln.x0 + ln.size * 1.2, rich: m[2] };
  }
  return null;
}

/* ---------- tables ---------- */

function hasText(s: string): boolean {
  return /[A-Za-z0-9]/.test(s);
}

/** Split a line into cells at gaps wider than a tab stop; leading bullet glyphs are not cells. */
function cells(ln: Line): { text: string; x: number }[] {
  const out: { text: string; x: number }[] = [];
  let cur = '';
  let cx = ln.runs[0].x;
  for (let i = 0; i < ln.runs.length; i++) {
    const r = ln.runs[i];
    if (i > 0) {
      const gap = r.x - (ln.runs[i - 1].x + ln.runs[i - 1].w);
      if (gap > ln.size * 1.25) {
        if (cur.trim()) out.push({ text: cur.trim(), x: cx });
        cur = '';
        cx = r.x;
      } else cur += ' ';
    }
    cur += r.text;
  }
  if (cur.trim()) out.push({ text: cur.trim(), x: cx });
  // drop marker glyphs (bullets) — they never form a column
  return out.filter((c) => hasText(c.text) && !(c.text.length === 1 && BULLET_CHARS.test(c.text)));
}

function compatible(a: { x: number }[], b: { x: number }[], tol: number): boolean {
  const need = Math.max(1, Math.min(a.length, b.length) - 1);
  let m = 0;
  for (const c of a) if (b.some((d) => Math.abs(d.x - c.x) < tol)) m++;
  return m >= need;
}

/** Find runs of vertically adjacent lines whose cell starts align — tables. */
export function detectTables(lines: Line[]): { tables: Table[]; rest: Line[] } {
  const sorted = [...lines].sort((a, b) => a.y - b.y);
  const tables: Table[] = [];
  const used = new Set<Line>();
  let i = 0;
  while (i < sorted.length) {
    const group: { line: Line; cells: { text: string; x: number }[] }[] = [];
    let j = i;
    while (j < sorted.length) {
      const ln = sorted[j];
      if (bulletOf(ln)) break; // list items are never table rows
      const cs = cells(ln);
      const isRow = cs.length >= 2 && cs.every((c) => c.text.length <= 70);
      if (!isRow) break;
      if (group.length) {
        const prev = group[group.length - 1];
        const vgap = ln.y0 - prev.line.y1;
        if (vgap > ln.size * 1.6 || !compatible(prev.cells, cs, ln.size * 1.2)) break;
      }
      group.push({ line: ln, cells: cs });
      j++;
    }
    // a table needs ≥2 rows and real column structure (≥3 cells somewhere, or ≥3 rows of 2)
    const maxCells = Math.max(0, ...group.map((g) => g.cells.length));
    if (group.length >= 2 && (maxCells >= 3 || group.length >= 3)) {
      const size = median(group.map((g) => g.line.size));
      const xs = group.flatMap((g) => g.cells.map((c) => c.x)).sort((a, b) => a - b);
      const cols: number[] = [];
      for (const x of xs) {
        if (!cols.length || x - cols[cols.length - 1] > size * 1.4) cols.push(x);
        else cols[cols.length - 1] = (cols[cols.length - 1] + x) / 2;
      }
      const rows = group.map((g) => {
        const row: string[] = Array(cols.length).fill('');
        for (const c of g.cells) {
          let best = 0;
          for (let k = 1; k < cols.length; k++) if (Math.abs(cols[k] - c.x) < Math.abs(cols[best] - c.x)) best = k;
          row[best] = row[best] ? row[best] + ' ' + c.text : c.text;
        }
        return row;
      });
      tables.push({
        rows,
        x0: Math.min(...group.map((g) => g.line.x0)),
        x1: Math.max(...group.map((g) => g.line.x1)),
        y0: group[0].line.y0,
        y1: group[group.length - 1].line.y1,
      });
      group.forEach((g) => used.add(g.line));
      i = j;
    } else i++;
  }
  return { tables, rest: sorted.filter((l) => !used.has(l)) };
}

/* ---------- reading order: XY-cut over whitespace ---------- */

interface Box { x0: number; x1: number; y0: number; y1: number }

function mergeIntervals(iv: [number, number][]): [number, number][] {
  iv.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of iv) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** Find a vertical whitespace gutter that separates two prose-like column sets. */
function findGutter(runs: Run[], box: Box, size: number): number | null {
  const regionW = box.x1 - box.x0;
  const wide = runs.filter((r) => r.w < regionW * 0.6);
  if (wide.length < 8) return null;
  const merged = mergeIntervals(wide.map((r) => [r.x, r.x + r.w] as [number, number]));
  let best: { x: number; w: number } | null = null;
  for (let i = 1; i < merged.length; i++) {
    const gapW = merged[i][0] - merged[i - 1][1];
    if (gapW < Math.max(8, size * 1.0)) continue;
    const gx = (merged[i - 1][1] + merged[i][0]) / 2;
    if (gx < box.x0 + regionW * 0.2 || gx > box.x1 - regionW * 0.2) continue;
    const lLines = buildLines(wide.filter((r) => r.x + r.w <= gx));
    const rLines = buildLines(wide.filter((r) => r.x >= gx));
    if (lLines.length < 3 || rLines.length < 3) continue;
    if (median(lLines.map((l) => l.text.length)) < 18 || median(rLines.map((l) => l.text.length)) < 18) continue;
    const regionH = box.y1 - box.y0;
    const hL = Math.max(...lLines.map((l) => l.y1)) - Math.min(...lLines.map((l) => l.y0));
    const hR = Math.max(...rLines.map((l) => l.y1)) - Math.min(...rLines.map((l) => l.y0));
    if (hL < regionH * 0.3 || hR < regionH * 0.3) continue;
    if (!best || gapW > best.w) best = { x: gx, w: gapW };
  }
  return best ? best.x : null;
}

function bbox(runs: Run[]): Box {
  return {
    x0: Math.min(...runs.map((r) => r.x)),
    x1: Math.max(...runs.map((r) => r.x + r.w)),
    y0: Math.min(...runs.map((r) => r.y)),
    y1: Math.max(...runs.map((r) => r.y + r.h)),
  };
}

/**
 * Recursively split the region on whitespace. Columns first when a tall gutter exists,
 * otherwise the largest horizontal band; leaves get table detection and y-ordering.
 */
export function orderRuns(runs: Run[], depth = 0): Leaf[] {
  if (!runs.length) return [];
  const box = bbox(runs);
  const lines = buildLines(runs);
  const size = median(lines.map((l) => l.size)) || 10;

  if (depth < 8 && lines.length >= 6) {
    const gx = findGutter(runs, box, size);
    if (gx !== null) {
      const spanning = runs.filter((r) => r.x < gx && r.x + r.w > gx);
      const L = runs.filter((r) => r.x + r.w <= gx);
      const R = runs.filter((r) => r.x >= gx);
      if (L.length && R.length) {
        const colTop = Math.min(...[...L, ...R].map((r) => r.y));
        const above = spanning.filter((r) => r.y < colTop);
        const below = spanning.filter((r) => r.y >= colTop);
        return [...orderRuns(above, depth + 1), ...orderRuns(L, depth + 1), ...orderRuns(R, depth + 1), ...orderRuns(below, depth + 1)];
      }
    }
    const sorted = [...lines].sort((a, b) => a.y0 - b.y0);
    let maxY1 = sorted[0].y1;
    let bestGap = 0;
    let cutY = 0;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].y0 - maxY1;
      if (gap > bestGap) {
        bestGap = gap;
        cutY = (maxY1 + sorted[i].y0) / 2;
      }
      maxY1 = Math.max(maxY1, sorted[i].y1);
    }
    if (bestGap > size * 1.1) {
      const top = runs.filter((r) => r.y + r.h / 2 < cutY);
      const bot = runs.filter((r) => r.y + r.h / 2 >= cutY);
      if (top.length && bot.length) return [...orderRuns(top, depth + 1), ...orderRuns(bot, depth + 1)];
    }
  }

  const { tables, rest } = detectTables(lines);
  const leaves: Leaf[] = tables.map((t) => ({ kind: 'table', table: t, x0: t.x0, x1: t.x1, y0: t.y0, y1: t.y1 }));
  const restSorted = rest.sort((a, b) => a.y - b.y);
  let cur: Line[] = [];
  const flush = () => {
    if (cur.length) {
      leaves.push({
        kind: 'lines',
        lines: cur,
        x0: Math.min(...cur.map((l) => l.x0)),
        x1: Math.max(...cur.map((l) => l.x1)),
        y0: cur[0].y0,
        y1: cur[cur.length - 1].y1,
      });
      cur = [];
    }
  };
  for (const ln of restSorted) {
    if (cur.length && tables.some((t) => t.y0 > cur[cur.length - 1].y && t.y1 < ln.y)) flush();
    cur.push(ln);
  }
  flush();
  leaves.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  return leaves;
}
