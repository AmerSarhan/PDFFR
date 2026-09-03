import type { Block, ListItem } from './types';

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').trim();
}

function list(items: ListItem[]): string {
  const counters: number[] = [];
  let prev = -1;
  return items
    .map((it) => {
      // nesting can only deepen one step at a time (a parent whose content was a figure leaves a gap)
      const level = Math.min(it.level, prev + 1);
      prev = level;
      counters.length = level + 1;
      counters[level] = (counters[level] || 0) + 1;
      const marker = it.ordered ? `${counters[level]}. ` : '- ';
      return '  '.repeat(level) + marker + it.text;
    })
    .join('\n');
}

/**
 * Join per-page markdown into one document. A paragraph that a page break cut mid-sentence
 * (no terminal punctuation, next page starts lowercase) is stitched back together.
 */
export function joinPages(pages: string[]): string {
  let out = '';
  for (const md of pages) {
    if (!md) continue;
    if (!out) {
      out = md;
      continue;
    }
    const continues = /[a-z0-9,;:\-–—]$/i.test(out) && !/\|\s*$/.test(out) && /^[a-z]/.test(md);
    out += (continues ? ' ' : '\n\n') + md;
  }
  return out;
}

export function blocksToMarkdown(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'heading':
        out.push('#'.repeat(b.level) + ' ' + b.text);
        break;
      case 'para':
        out.push(b.text);
        break;
      case 'math':
        out.push(`$$\n${b.latex}\n$$`);
        break;
      case 'list':
        out.push(list(b.items));
        break;
      case 'table': {
        const cols = Math.max(...b.rows.map((r) => r.length));
        const norm = (r: string[]) => {
          const a = r.map(cell);
          while (a.length < cols) a.push('');
          return '| ' + a.join(' | ') + ' |';
        };
        out.push(
          [
            norm(b.rows[0]),
            '| ' + Array(cols).fill('---').join(' | ') + ' |',
            ...b.rows.slice(1).map(norm),
          ].join('\n'),
        );
        break;
      }
      case 'pending':
        out.push(`<!-- ${b.label} -->`);
        break;
    }
  }
  return out.join('\n\n');
}
