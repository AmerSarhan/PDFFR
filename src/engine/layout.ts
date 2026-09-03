import type { Leaf, Line, Rules, Run, Table } from './types.js';

/* ---------- small helpers ---------- */
export function median(a: number[]): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}

function esc(s: string): string {
  return s.replace(/([*_`\\])/g, '\\$1');
}

/* ---------- math ---------- */

const TEX: Record<string, string> = {
  α: '\\alpha',
  β: '\\beta',
  γ: '\\gamma',
  δ: '\\delta',
  ε: '\\epsilon',
  ζ: '\\zeta',
  η: '\\eta',
  θ: '\\theta',
  ι: '\\iota',
  κ: '\\kappa',
  λ: '\\lambda',
  μ: '\\mu',
  ν: '\\nu',
  ξ: '\\xi',
  π: '\\pi',
  ρ: '\\rho',
  σ: '\\sigma',
  ς: '\\varsigma',
  τ: '\\tau',
  υ: '\\upsilon',
  φ: '\\phi',
  χ: '\\chi',
  ψ: '\\psi',
  ω: '\\omega',
  Γ: '\\Gamma',
  Δ: '\\Delta',
  Θ: '\\Theta',
  Λ: '\\Lambda',
  Ξ: '\\Xi',
  Π: '\\Pi',
  Σ: '\\Sigma',
  Φ: '\\Phi',
  Ψ: '\\Psi',
  Ω: '\\Omega',
  '∑': '\\sum',
  '∏': '\\prod',
  '∫': '\\int',
  '√': '\\sqrt',
  '∞': '\\infty',
  '≤': '\\le',
  '≥': '\\ge',
  '≠': '\\ne',
  '≈': '\\approx',
  '≡': '\\equiv',
  '±': '\\pm',
  '×': '\\times',
  '÷': '\\div',
  '∂': '\\partial',
  '∇': '\\nabla',
  '∈': '\\in',
  '∉': '\\notin',
  '⊂': '\\subset',
  '⊆': '\\subseteq',
  '⊃': '\\supset',
  '⊇': '\\supseteq',
  '∪': '\\cup',
  '∩': '\\cap',
  '→': '\\to',
  '←': '\\leftarrow',
  '⇒': '\\Rightarrow',
  '⇔': '\\Leftrightarrow',
  '∀': '\\forall',
  '∃': '\\exists',
  '∝': '\\propto',
  '∅': '\\emptyset',
  '⋅': '\\cdot',
  '·': '\\cdot',
  '−': '-',
};
// a lone, larger Σ or Π in a math font is an operator, not a letter
const BIG_OP: Record<string, string> = { Σ: '\\sum', Π: '\\prod' };
const MATH_TOKEN = /^[A-Za-z0-9=+\-−±×÷<>()[\]|.,]{1,3}$/;

function toTex(r: Run, lineSize: number): string {
  if (r.tex) return r.tex;
  const t = r.text.trim();
  if (BIG_OP[t] && r.size > lineSize * 1.08) return BIG_OP[t];
  let out = '';
  for (const ch of t) {
    const m = TEX[ch];
    if (m) out += m + ' ';
    else if ('%#&{}'.includes(ch)) out += '\\' + ch;
    else out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Fractions: a short horizontal rule with math above and below it (overlapping its span)
 * becomes one synthetic run carrying `\frac{…}{…}`. Returns the runs with the folded parts
 * replaced and the rules with the consumed bars removed.
 */
export function foldFractions(runs: Run[], rules?: Rules): { runs: Run[]; rules?: Rules } {
  if (!rules || !rules.h.length || !runs.some((r) => r.math)) return { runs, rules };
  const used = new Set<Run>();
  const usedBars = new Set<Rules['h'][number]>();
  const out: Run[] = [];
  for (const bar of rules.h) {
    const w = bar.x1 - bar.x0;
    if (w > 220) continue;
    const overlaps = (r: Run) => Math.min(r.x + r.w, bar.x1 + 2) - Math.max(r.x, bar.x0 - 2) > r.w * 0.5;
    const near = runs.filter((r) => !used.has(r) && overlaps(r));
    if (!near.length) continue;
    const size = median(near.map((r) => r.size)) || 10;
    if (w < size * 0.8) continue;
    const above = near.filter((r) => r.y + r.h <= bar.y + 1.5 && r.y + r.h >= bar.y - size * 1.8);
    const below = near.filter((r) => r.y >= bar.y - 1.5 && r.y <= bar.y + size * 1.8);
    if (!above.length || !below.length) continue;
    if (![...above, ...below].some((r) => r.math || /^[\p{N}\p{L}]{1,3}$/u.test(r.text.trim()))) continue;
    const tex = (g: Run[]) =>
      joinRuns(
        g.map((r) => ({ ...r, math: true })),
        size,
      ).rich.replace(/^\$|\$$/g, '');
    const num = tex(above);
    const den = tex(below);
    for (const r of [...above, ...below]) used.add(r);
    usedBars.add(bar);
    const base = above[0];
    out.push({
      ...base,
      text: `${above.map((r) => r.text.trim()).join('')}/${below.map((r) => r.text.trim()).join('')}`,
      tex: `\\frac{${num}}{${den}}`,
      x: bar.x0,
      y: bar.y - size * 0.6,
      w,
      h: size * 1.2,
      size,
      math: true,
    });
  }
  if (!used.size) return { runs, rules };
  return {
    runs: [...runs.filter((r) => !used.has(r)), ...out],
    rules: { h: rules.h.filter((b) => !usedBars.has(b)), v: rules.v },
  };
}

/* ---------- runs → lines ---------- */

/** Group runs sharing a baseline band into lines, sorted top-to-bottom. */
export function buildLines(runs: Run[]): Line[] {
  const rs = runs.filter((r) => r.text.trim()).sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x);
  // yc is char-weighted so a superscript never drags a line's centre; y0/y1 is the union box
  const lines: { runs: Run[]; yc: number; h: number; y0: number; y1: number; wt: number }[] = [];
  for (const r of rs) {
    const yc = r.y + r.h / 2;
    const wt = Math.max(1, r.text.trim().length) * r.h;
    let best: (typeof lines)[number] | null = null;
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 6; i--) {
      const ln = lines[i];
      if (Math.abs(yc - ln.yc) < Math.min(r.h, ln.h) * 0.55) {
        best = ln;
        break;
      }
      // a superscript/subscript (either side much smaller) merely overlaps the other's box
      const small = Math.min(r.h, ln.h) < Math.max(r.h, ln.h) * 0.75;
      if (small && r.y < ln.y1 && r.y + r.h > ln.y0) {
        best = ln;
        break;
      }
    }
    if (best) {
      best.runs.push(r);
      best.yc = (best.yc * best.wt + yc * wt) / (best.wt + wt);
      best.wt += wt;
      best.h = Math.max(best.h, r.h);
      best.y0 = Math.min(best.y0, r.y);
      best.y1 = Math.max(best.y1, r.y + r.h);
    } else lines.push({ runs: [r], yc, h: r.h, y0: r.y, y1: r.y + r.h, wt });
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
  const { text, rich, math } = joinRuns(runs, size);
  return {
    runs,
    x0,
    x1,
    y0,
    y1,
    y: (y0 + y1) / 2,
    size,
    text,
    rich,
    math,
    bold: totalChars > 0 && boldChars / totalChars >= 0.8,
  };
}

/**
 * Join runs left→right, inserting spaces across gaps and emitting inline markdown for style
 * changes. Runs in math fonts (plus the sub/superscripts and short tokens glued to them) become
 * a `$…$` span in LaTeX; the line is `math` when every run belongs to one.
 */
export function joinRuns(runs: Run[], lineSize: number): { text: string; rich: string; math: boolean } {
  const rs = runs.filter((r) => r.text.trim());
  if (!rs.length) return { text: '', rich: '', math: false };
  const base = rs.filter((r) => r.size >= lineSize * 0.72);
  const ref = base.length ? base : rs;
  const top = Math.min(...ref.map((r) => r.y));
  const bottom = Math.max(...ref.map((r) => r.y + r.h));
  const mid = (top + bottom) / 2;
  const small = rs.map((r) => r.size < lineSize * 0.72);
  const sup = rs.map((r, i) => small[i] && r.y + r.h / 2 < mid - lineSize * 0.12);
  const sub = rs.map((r, i) => small[i] && r.y + r.h / 2 > mid + lineSize * 0.12);
  const gapBefore = rs.map((r, i) => (i ? r.x - (rs[i - 1].x + rs[i - 1].w) : Infinity));

  // letter-spaced (tracked) text: most runs are single glyphs with a uniform gap — join them
  // without spaces, and only a gap clearly larger than the tracking is a word break
  const singles = rs.filter((r) => r.text.trim().length === 1).length;
  const innerGaps = gapBefore.slice(1).filter((g) => g >= 0 && g < lineSize);
  const tracking = rs.length >= 4 && singles >= rs.length * 0.7 && innerGaps.length ? median(innerGaps) : 0;

  // math spans: math-font runs (or an italic single letter carrying a script, math typed in a text
  // font), extended over attached scripts and short tokens next to them
  const inMath = rs.map(
    (r, i) =>
      !!r.math ||
      (r.italic &&
        /^[A-Za-z]$/.test(r.text.trim()) &&
        i + 1 < rs.length &&
        (sup[i + 1] || sub[i + 1]) &&
        gapBefore[i + 1] < lineSize * 0.3),
  );
  let grew = true;
  while (grew) {
    grew = false;
    for (let i = 0; i < rs.length; i++) {
      if (inMath[i]) continue;
      const cand = sup[i] || sub[i] || MATH_TOKEN.test(rs[i].text.trim());
      if (!cand) continue;
      const left = i > 0 && inMath[i - 1] && gapBefore[i] < lineSize * 0.6;
      const right = i + 1 < rs.length && inMath[i + 1] && gapBefore[i + 1] < lineSize * 0.6;
      if (left || right) {
        inMath[i] = true;
        grew = true;
      }
    }
  }

  const sep = (i: number) => {
    if (!i) return '';
    const prev = rs[i - 1];
    const r = rs[i];
    const gap = gapBefore[i];
    if (tracking > lineSize * 0.05) return gap > tracking * 1.8 + lineSize * 0.05 ? ' ' : '';
    if (gap > lineSize * 0.22 || /\s$/.test(prev.text) || /^\s/.test(r.text)) return ' ';
    if (gap > lineSize * 0.06 && !/[-(\[/]$/.test(prev.text) && !/^[.,;:)\]]/.test(r.text)) return ' ';
    return '';
  };

  type Seg = { text: string; bold: boolean; italic: boolean; sup: boolean; sub: boolean; latex?: string };
  const segs: Seg[] = [];
  let plain = '';
  for (let i = 0; i < rs.length;) {
    if (inMath[i]) {
      let j = i;
      while (j + 1 < rs.length && inMath[j + 1]) j++;
      // attach scripts to the base token on their left
      const bases: { tex: string; sup: string; sub: string }[] = [];
      let span = '';
      for (let k = i; k <= j; k++) {
        span += (k > i ? sep(k) : '') + rs[k].text.trim();
        const tex = toTex(rs[k], lineSize);
        const last = bases[bases.length - 1];
        if (sup[k] && last) last.sup += tex;
        else if (sub[k] && last) last.sub += tex;
        else bases.push({ tex, sup: '', sub: '' });
      }
      const latex = bases
        .map((b) => b.tex + (b.sub ? `_{${b.sub}}` : '') + (b.sup ? `^{${b.sup}}` : ''))
        .join(' ');
      plain += sep(i) + span;
      segs.push({
        text: (segs.length ? sep(i) : '') + span,
        bold: false,
        italic: false,
        sup: false,
        sub: false,
        latex,
      });
      i = j + 1;
      continue;
    }
    const r = rs[i];
    const t = r.text.trim();
    const s = sep(i);
    plain += s + t;
    const last = segs[segs.length - 1];
    if (
      last &&
      !last.latex &&
      last.bold === r.bold &&
      last.italic === r.italic &&
      last.sup === sup[i] &&
      last.sub === sub[i]
    ) {
      last.text += s + t;
    } else
      segs.push({
        text: (segs.length ? s : '') + t,
        bold: r.bold,
        italic: r.italic,
        sup: sup[i],
        sub: sub[i],
      });
    i++;
  }

  let rich = '';
  for (const s of segs) {
    const lead = s.text.match(/^\s*/)![0];
    let body = s.text.slice(lead.length);
    if (!body) continue;
    if (s.latex) body = `$${s.latex}$`;
    else if (!/[\p{L}\p{N}]/u.test(body))
      body = esc(body); // bare punctuation never carries markup
    else {
      body = esc(body);
      if (s.sup) body = `<sup>${body}</sup>`;
      else if (s.sub) body = `<sub>${body}</sub>`;
      else if (s.bold && s.italic) body = `***${body}***`;
      else if (s.bold) body = `**${body}**`;
      else if (s.italic) body = `*${body}*`;
    }
    rich += lead + body;
  }
  return {
    text: plain.replace(/\s+/g, ' ').trim(),
    rich: rich.replace(/\s+/g, ' ').trim(),
    math: inMath.every(Boolean) && rs.some((r) => r.math),
  };
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
  if (ln.runs.length > 1 && t0.length <= 4 && !r0.math) {
    const r1 = ln.runs[1];
    const gap = r1.x - (r0.x + r0.w);
    const symbolFont = BULLET_FONT.test(r0.font || '');
    if (gap > ln.size * 0.35 || symbolFont) {
      const isGlyph = t0.length === 1 && (BULLET_CHARS.test(t0) || !/[A-Za-z0-9]/.test(t0) || symbolFont);
      if (isGlyph)
        return { marker: t0, ordered: false, textX: r1.x, rich: joinRuns(ln.runs.slice(1), ln.size).rich };
      if (ORDERED_MARKER.test(t0))
        return { marker: t0, ordered: true, textX: r1.x, rich: joinRuns(ln.runs.slice(1), ln.size).rich };
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
  return /[\p{L}\p{N}]/u.test(s);
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
  return out.filter((c) => hasText(c.text) && !(c.text.length === 1 && BULLET_CHARS.test(c.text)));
}

function compatible(a: { x: number }[], b: { x: number }[], tol: number): boolean {
  const need = Math.max(1, Math.min(a.length, b.length) - 1);
  let m = 0;
  for (const c of a) if (b.some((d) => Math.abs(d.x - c.x) < tol)) m++;
  return m >= need;
}

/** Find runs of vertically adjacent lines whose cell starts align — tables without rules. */
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
      if (bulletOf(ln) || ln.math) break;
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
          for (let k = 1; k < cols.length; k++)
            if (Math.abs(cols[k] - c.x) < Math.abs(cols[best] - c.x)) best = k;
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

/**
 * Tables drawn with ruling lines. Horizontal rules that overlap horizontally form a frame;
 * vertical rules spanning the frame give the columns (or, with rules only between rows, cells
 * come from gaps and columns from aligned starts). Text is assigned to cells by position, so
 * multi-line cells and unaligned starts are fine.
 */
export function detectRuledTables(lines: Line[], rules?: Rules): { tables: Table[]; rest: Line[] } {
  if (!rules || rules.h.length < 2) return { tables: [], rest: lines };
  const bands: { y: number; x0: number; x1: number }[] = [];
  for (const r of [...rules.h].sort((a, b) => a.y - b.y)) {
    const l = bands[bands.length - 1];
    if (l && Math.abs(l.y - r.y) < 1.5) {
      l.x0 = Math.min(l.x0, r.x0);
      l.x1 = Math.max(l.x1, r.x1);
    } else bands.push({ ...r });
  }
  const frames: { ys: number[]; x0: number; x1: number }[] = [];
  for (const b of bands) {
    const f = frames[frames.length - 1];
    if (f) {
      const overlap = Math.min(f.x1, b.x1) - Math.max(f.x0, b.x0);
      const shorter = Math.min(f.x1 - f.x0, b.x1 - b.x0);
      if (overlap > shorter * 0.5 && b.y - f.ys[f.ys.length - 1] < 400) {
        f.ys.push(b.y);
        f.x0 = Math.min(f.x0, b.x0);
        f.x1 = Math.max(f.x1, b.x1);
        continue;
      }
    }
    frames.push({ ys: [b.y], x0: b.x0, x1: b.x1 });
  }

  const tables: Table[] = [];
  const used = new Set<Line>();
  for (const f of frames) {
    if (f.ys.length < 2) continue;
    const y0 = f.ys[0];
    const y1 = f.ys[f.ys.length - 1];
    if (y1 - y0 < 8) continue;
    const inside = lines.filter(
      (l) => !used.has(l) && l.y > y0 - 1 && l.y < y1 + 1 && l.x0 >= f.x0 - 4 && l.x1 <= f.x1 + 4,
    );
    if (!inside.length) continue;
    const size = median(inside.map((l) => l.size)) || 10;

    const vs = rules.v
      .filter(
        (v) =>
          v.x >= f.x0 - 2 && v.x <= f.x1 + 2 && Math.min(v.y1, y1) - Math.max(v.y0, y0) > (y1 - y0) * 0.5,
      )
      .map((v) => v.x)
      .sort((a, b) => a - b);
    const colBounds: number[] = [];
    for (const x of vs) if (!colBounds.length || x - colBounds[colBounds.length - 1] > 1.5) colBounds.push(x);

    let rowBounds = f.ys;
    if (rowBounds.length < 3) {
      // only a top and bottom rule: each baseline cluster is a row
      const cl: number[] = [];
      for (const y of inside.map((l) => l.y).sort((a, b) => a - b))
        if (!cl.length || y - cl[cl.length - 1] > size * 0.8) cl.push(y);
      rowBounds = [y0, ...cl.slice(1).map((y, i) => (cl[i] + y) / 2), y1];
    }
    const nRows = rowBounds.length - 1;
    if (nRows < 1) continue;
    const rowOf = (y: number) => {
      for (let i = 0; i < nRows; i++) if (y < rowBounds[i + 1]) return i;
      return nRows - 1;
    };
    const rows: string[][] = Array.from({ length: nRows }, () => []);
    const put = (ri: number, ci: number, t: string) => {
      rows[ri][ci] = rows[ri][ci] ? rows[ri][ci] + ' ' + t : t;
    };

    if (colBounds.length >= 2) {
      const nCols = colBounds.length - 1;
      for (const r of rows) for (let c = 0; c < nCols; c++) r.push('');
      for (const l of inside) {
        const ri = rowOf(l.y);
        for (const run of l.runs) {
          const t = run.text.trim();
          if (!t) continue;
          const cx = run.x + run.w / 2;
          let ci = 0;
          for (let c = 0; c < nCols; c++) if (cx >= colBounds[c]) ci = c;
          put(ri, ci, t);
        }
      }
    } else {
      const rowCells = inside.map((l) => ({ ri: rowOf(l.y), cells: cells(l) }));
      const xs = rowCells.flatMap((r) => r.cells.map((c) => c.x)).sort((a, b) => a - b);
      const cols: number[] = [];
      for (const x of xs) {
        if (!cols.length || x - cols[cols.length - 1] > size * 1.4) cols.push(x);
        else cols[cols.length - 1] = (cols[cols.length - 1] + x) / 2;
      }
      if (cols.length < 2) continue;
      for (const r of rows) for (let c = 0; c < cols.length; c++) r.push('');
      for (const rc of rowCells) {
        for (const c of rc.cells) {
          let best = 0;
          for (let k = 1; k < cols.length; k++)
            if (Math.abs(cols[k] - c.x) < Math.abs(cols[best] - c.x)) best = k;
          put(rc.ri, best, c.text);
        }
      }
    }
    const filled = rows.filter((r) => r.some((c) => c));
    if (filled.length < 2 || filled[0].length < 2) continue;
    tables.push({ rows: filled, x0: f.x0, x1: f.x1, y0, y1 });
    inside.forEach((l) => used.add(l));
  }
  return { tables, rest: lines.filter((l) => !used.has(l)) };
}

/* ---------- reading order: XY-cut over whitespace ---------- */

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

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

type Gutter = { x: number; mode: 'columns' | 'label' };

/**
 * Find a vertical whitespace gutter worth cutting at. Three geometric signatures qualify:
 * prose on both sides (text columns); a narrow side with a few short lines beside a prose side
 * with at least 3× as many lines (a label column — its lines become headings over the prose);
 * or lines that do NOT share baselines across the gap (card lanes). Rows that align across the
 * gap are a table, and tables are never cut.
 */
function findGutter(runs: Run[], box: Box, size: number): Gutter | null {
  const regionW = box.x1 - box.x0;
  const wide = runs.filter((r) => r.w < regionW * 0.6);
  if (wide.length < 6) return null;
  const merged = mergeIntervals(wide.map((r) => [r.x, r.x + r.w] as [number, number]));
  let best: (Gutter & { w: number }) | null = null;
  for (let i = 1; i < merged.length; i++) {
    const gapW = merged[i][0] - merged[i - 1][1];
    if (gapW < Math.max(8, size * 1.0)) continue;
    const gx = (merged[i - 1][1] + merged[i][0]) / 2;
    if (gx < box.x0 + regionW * 0.12 || gx > box.x1 - regionW * 0.2) continue;
    // the gap comes from the narrow runs; the sides are judged on every run that does not cross it
    const lLines = buildLines(runs.filter((r) => r.x + r.w <= gx));
    const rLines = buildLines(runs.filter((r) => r.x >= gx));
    if (!lLines.length || !rLines.length) continue;
    const prose = (ls: Line[]) => ls.length >= 3 && median(ls.map((l) => l.text.length)) >= 18;
    const proseL = prose(lLines);
    const proseR = prose(rLines);
    const regionH = box.y1 - box.y0;
    const span = (ls: Line[]) => Math.max(...ls.map((l) => l.y1)) - Math.min(...ls.map((l) => l.y0));
    const small = lLines.length <= rLines.length ? lLines : rLines;
    const big = small === lLines ? rLines : lLines;
    const aligned =
      small.filter((a) => big.some((b) => Math.abs(a.y - b.y) < a.size * 0.35)).length / small.length;

    let mode: Gutter['mode'] | null = null;
    if (proseL && proseR && span(lLines) >= regionH * 0.3 && span(rLines) >= regionH * 0.3) mode = 'columns';
    else if (!proseL && proseR && rLines.length >= lLines.length * 3 && span(rLines) >= regionH * 0.3)
      mode = 'label';
    else if (
      aligned < 0.5 &&
      lLines.length >= 3 &&
      rLines.length >= 3 &&
      span(lLines) >= regionH * 0.3 &&
      span(rLines) >= regionH * 0.3
    )
      mode = 'columns';
    if (!mode) continue;
    if (!best || gapW > best.w) best = { x: gx, mode, w: gapW };
  }
  return best ? { x: best.x, mode: best.mode } : null;
}

/** Lines of a label column, grouped into one leaf per label (consecutive lines within 0.9·size). */
function labelLeaves(runs: Run[]): Leaf[] {
  const lines = buildLines(runs).sort((a, b) => a.y - b.y);
  const leaves: Leaf[] = [];
  let cur: Line[] = [];
  const flush = () => {
    if (!cur.length) return;
    leaves.push({
      kind: 'lines',
      lines: cur,
      label: true,
      x0: Math.min(...cur.map((l) => l.x0)),
      x1: Math.max(...cur.map((l) => l.x1)),
      y0: cur[0].y0,
      y1: cur[cur.length - 1].y1,
    });
    cur = [];
  };
  for (const l of lines) {
    if (cur.length && l.y0 - cur[cur.length - 1].y1 > l.size * 0.9) flush();
    cur.push(l);
  }
  flush();
  return leaves;
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
export function orderRuns(runs: Run[], rules?: Rules, depth = 0): Leaf[] {
  if (!runs.length) return [];
  if (depth === 0) ({ runs, rules } = foldFractions(runs, rules));
  const box = bbox(runs);
  const lines = buildLines(runs);
  const size = median(lines.map((l) => l.size)) || 10;

  if (depth < 8 && lines.length >= 5) {
    const g = findGutter(runs, box, size);
    if (g) {
      const gx = g.x;
      const spanning = runs.filter((r) => r.x < gx && r.x + r.w > gx);
      const L = runs.filter((r) => r.x + r.w <= gx);
      const R = runs.filter((r) => r.x >= gx);
      if (L.length && R.length) {
        const colTop = Math.min(...[...L, ...R].map((r) => r.y));
        const above = spanning.filter((r) => r.y < colTop);
        const below = spanning.filter((r) => r.y >= colTop);
        // label column: its lines head the prose beside them (the structure pass sorts by y)
        const left = g.mode === 'label' ? labelLeaves(L) : orderRuns(L, rules, depth + 1);
        return [
          ...orderRuns(above, rules, depth + 1),
          ...left,
          ...orderRuns(R, rules, depth + 1),
          ...orderRuns(below, rules, depth + 1),
        ];
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
    // never cut through a ruled frame
    const insideFrame = rules?.h.some((r) => Math.abs(r.y - cutY) < 0.5)
      ? false
      : rules?.v.some((v) => v.y0 < cutY && v.y1 > cutY);
    if (bestGap > size * 1.1 && !insideFrame) {
      const top = runs.filter((r) => r.y + r.h / 2 < cutY);
      const bot = runs.filter((r) => r.y + r.h / 2 >= cutY);
      if (top.length && bot.length)
        return [...orderRuns(top, rules, depth + 1), ...orderRuns(bot, rules, depth + 1)];
    }
  }

  const ruled = detectRuledTables(lines, rules);
  const aligned = detectTables(ruled.rest);
  const tables = [...ruled.tables, ...aligned.tables];
  const leaves: Leaf[] = tables.map((t) => ({
    kind: 'table',
    table: t,
    x0: t.x0,
    x1: t.x1,
    y0: t.y0,
    y1: t.y1,
  }));
  const restSorted = aligned.rest.sort((a, b) => a.y - b.y);
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
