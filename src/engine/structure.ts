import type { Block, Leaf, Line, ListItem } from './types';
import { bulletOf, median } from './layout';

/** Char-weighted modal font size — the body size everything else is measured against. */
export function bodySize(lines: Line[]): number {
  const freq = new Map<number, number>();
  for (const l of lines) {
    const k = Math.round(l.size * 2) / 2;
    freq.set(k, (freq.get(k) || 0) + l.text.length);
  }
  let best = 10;
  let bc = -1;
  for (const [k, c] of freq) {
    if (c > bc) {
      bc = c;
      best = k;
    }
  }
  return best || 10;
}

export function normKey(s: string): string {
  return s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/** Running headers/footers: text recurring in the top/bottom band on at least half the pages. */
export function computeDropSet(pages: { lines: Line[]; height: number }[]): Set<string> {
  const drop = new Set<string>();
  if (pages.length < 2) return drop;
  const count = new Map<string, number>();
  for (const p of pages) {
    const seen = new Set<string>();
    for (const l of p.lines) if (l.y < p.height * 0.09 || l.y > p.height * 0.91) seen.add(normKey(l.text));
    for (const k of seen) count.set(k, (count.get(k) || 0) + 1);
  }
  const need = Math.max(2, Math.ceil(pages.length * 0.5));
  for (const [k, c] of count) if (c >= need && k.length > 0) drop.add(k);
  return drop;
}

const PAGE_NUM = /^(page\s*)?#+(\s*(of|\/)\s*#+)?$/;

function isPageFurniture(l: Line, pageH: number, drop: Set<string>, multiPage: boolean): boolean {
  const band = l.y < pageH * 0.09 || l.y > pageH * 0.91;
  if (!band) return false;
  const k = normKey(l.text);
  if (drop.has(k)) return true;
  return multiPage && PAGE_NUM.test(k);
}

/** What the structure pass consumes: native leaves, OCR'd figure groups, and placeholders — all y-ordered. */
export type LayoutItem =
  | Leaf
  | { kind: 'group'; y0: number; x0: number; leaves: Leaf[]; body: number; headings: boolean }
  | { kind: 'pending'; y0: number; x0: number; label: string };

interface Ctx {
  body: number;
  pageH: number;
  drop: Set<string>;
  multiPage: boolean;
  /** text inside an OCR'd figure never shapes the document outline */
  headings: boolean;
}

/** Turn ordered layout items into markdown blocks. */
export function toBlocks(
  items: LayoutItem[],
  body: number,
  pageH: number,
  drop: Set<string>,
  multiPage: boolean,
  headings = true,
): Block[] {
  const blocks: Block[] = [];
  const sorted = [...items].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  for (const it of sorted) {
    if (it.kind === 'pending') blocks.push({ type: 'pending', label: it.label });
    else if (it.kind === 'group')
      blocks.push(...toBlocks(it.leaves, it.body, pageH, new Set(), false, it.headings));
    else if (it.kind === 'table') blocks.push({ type: 'table', rows: it.table.rows });
    else blocks.push(...linesToBlocks(it.lines, it.x1 - it.x0, { body, pageH, drop, multiPage, headings }));
  }
  return blocks;
}

const LONE_MARKER = /^([•‣◦▪▫■□●○·\-–—*§o]|[^\w\s])$/;

function linesToBlocks(all: Line[], leafW: number, ctx: Ctx): Block[] {
  const blocks: Block[] = [];
  const lines = all
    .filter((l) => !isPageFurniture(l, ctx.pageH, ctx.drop, ctx.multiPage))
    // a bullet glyph alone on its line marks an item whose content is a figure — nothing to say
    .filter((l) => !(l.runs.length === 1 && LONE_MARKER.test(l.text) && !l.math));
  if (!lines.length) return blocks;

  // indent levels for nested lists: cluster the x of every marker in this leaf
  const markerXs: number[] = [];
  for (const l of lines) if (bulletOf(l)) markerXs.push(l.x0);
  const size0 = median(lines.map((l) => l.size)) || 10;
  const levels: number[] = [];
  for (const x of markerXs.sort((a, b) => a - b)) {
    if (!levels.length || x - levels[levels.length - 1] > size0 * 0.8) levels.push(x);
  }
  const levelOf = (x: number) => {
    let best = 0;
    for (let i = 1; i < levels.length; i++)
      if (Math.abs(levels[i] - x) < Math.abs(levels[best] - x)) best = i;
    return best;
  };

  // the leaf's typical leading (baseline-to-baseline), so a paragraph break is a step clearly
  // larger than the body's own line spacing rather than a fixed multiple of font size
  const leads: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const d = lines[i].y - lines[i - 1].y;
    if (d > lines[i].size * 0.6) leads.push(d);
  }
  const typicalLead = median(leads);

  let para: string[] = [];
  let list: { items: ListItem[]; textX: number } | null = null;
  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: 'para', text: joinWrapped(para) });
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ type: 'list', items: list.items });
      list = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const next = lines[i + 1];
    const prev = lines[i - 1];
    const ratio = l.size / ctx.body;
    const short = l.text.length <= 100;
    const gapBefore = prev ? l.y0 - prev.y1 : Infinity;
    const gapAfter = next ? next.y0 - l.y1 : Infinity;
    const endsSentence = /[.:;,]$/.test(l.text);
    const bullet = bulletOf(l);

    // --- a line that is entirely an equation: display math when it stands on its own ---
    if (l.math) {
      const standalone = l.x1 - l.x0 < leafW * 0.85 || gapBefore > l.size * 0.4 || gapAfter > l.size * 0.4;
      if (standalone) {
        flushPara();
        flushList();
        blocks.push({ type: 'math', latex: l.rich.replace(/^\$|\$$/g, '') });
        continue;
      }
    }

    // --- heading by size, or by an isolated bold line ---
    let level = 0;
    if (!bullet && !l.math && ctx.headings) {
      if (ratio >= 1.7 && short) level = 1;
      else if (ratio >= 1.32 && short) level = 2;
      else if (ratio >= 1.12 && short && !endsSentence) level = 3;
      else if (
        l.bold &&
        short &&
        !endsSentence &&
        ratio >= 0.95 &&
        (gapBefore > l.size * 0.35 || !prev) &&
        (gapAfter > l.size * 0.35 || !next || !next.bold) &&
        l.x1 - l.x0 < leafW * 0.85
      )
        level = 3;
    }
    if (level) {
      flushPara();
      flushList();
      blocks.push({ type: 'heading', level, text: l.text });
      continue;
    }

    // --- list items and their wrapped continuations ---
    if (bullet) {
      flushPara();
      if (!list) list = { items: [], textX: bullet.textX };
      list.items.push({ text: bullet.rich, level: levelOf(l.x0), ordered: bullet.ordered });
      list.textX = bullet.textX;
      continue;
    }
    if (list && l.x0 > list.textX - l.size * 0.3 && gapBefore < l.size * 0.9) {
      list.items[list.items.length - 1].text += ' ' + l.rich;
      continue;
    }
    flushList();

    // --- paragraph text ---
    para.push(l.rich);
    const shortLine = l.x1 - l.x0 < leafW * 0.72;
    const lead = next ? next.y - l.y : 0;
    const bigGap =
      typicalLead > 0
        ? lead > typicalLead * 1.3 + l.size * 0.1 || (next && next.size !== l.size && gapAfter > l.size * 0.5)
        : gapAfter > l.size * 0.55;
    const breakAfter =
      !next || bigGap || (shortLine && /[.!?]["')\]]?$/.test(l.text) && !/[a-z,]$/.test(l.text));
    if (breakAfter) flushPara();
  }
  flushPara();
  flushList();
  return blocks;
}

const KEEP_HYPHEN = /(^|\s)(re|co|pre|non|self|anti|multi|semi|cross|ex|e)-$/i;

/** Join wrapped lines, repairing soft hyphenation but keeping real prefix hyphens. */
function joinWrapped(lines: string[]): string {
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (i === 0) {
      out = l;
      continue;
    }
    if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(l) && !KEEP_HYPHEN.test(out)) out = out.slice(0, -1) + l;
    else if (/[A-Za-z]-$/.test(out) && /^[a-z]/.test(l)) out += l;
    else out += ' ' + l;
  }
  return out;
}

export function countBlocks(blocks: Block[]): number {
  return blocks.filter((b) => b.type !== 'pending').length;
}
