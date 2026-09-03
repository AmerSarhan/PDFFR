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
