#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { decompileFile, terminateOcr } from '../dist/node.js';

const HELP = `pdffr — PDF → Markdown decompiler

usage: pdffr <file.pdf> [options]

  -o, --out <file>   write the result to a file instead of stdout
  --json             emit JSON: { pages: [{ page, markdown, blocks }], markdown, stats }
  --pages <spec>     only these pages, e.g. 1-3,7 (default all)
  --no-ocr           never rasterize; native text only
  --lang <codes>     tesseract language(s), e.g. eng, deu, eng+ara (default eng)
  -q, --quiet        no progress on stderr
  -v, --version      print the version
  -h, --help         this text
`;

const args = process.argv.slice(2);
let file = '';
let out = '';
let json = false;
let pagesSpec = '';
let ocr = true;
let lang = 'eng';
let quiet = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') {
    process.stdout.write(HELP);
    process.exit(0);
  } else if (a === '-v' || a === '--version') {
    process.stdout.write(createRequire(import.meta.url)('../package.json').version + '\n');
    process.exit(0);
  } else if (a === '-o' || a === '--out') out = args[++i] || '';
  else if (a === '--json') json = true;
  else if (a === '--pages') pagesSpec = args[++i] || '';
  else if (a === '--no-ocr') ocr = false;
  else if (a === '--lang') lang = args[++i] || 'eng';
  else if (a === '-q' || a === '--quiet') quiet = true;
  else if (!file && !a.startsWith('-')) file = a;
  else {
    process.stderr.write(`unknown argument: ${a}\n${HELP}`);
    process.exit(2);
  }
}
if (!file) {
  process.stderr.write(HELP);
  process.exit(2);
}

/** "1-3,7" → Set of page numbers */
function pageSet(spec, total) {
  const set = new Set();
  for (const part of spec.split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`bad page range: ${part}`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let p = Math.max(1, a); p <= Math.min(total, b); p++) set.add(p);
  }
  return set;
}

try {
  const res = await decompileFile(file, {
    ocr,
    lang,
    onEvent: quiet
      ? undefined
      : (e) => e.type === 'trace' && process.stderr.write(`${e.kind.padEnd(6)} ${e.msg}\n`),
  });
  const want = pagesSpec ? pageSet(pagesSpec, res.stats.pages) : null;
  const pages = want ? res.pages.filter((p) => want.has(p.page)) : res.pages;
  const markdown = want
    ? pages
        .map((p) => p.markdown)
        .filter(Boolean)
        .join('\n\n')
    : res.markdown;
  const text = json
    ? JSON.stringify(
        {
          file,
          markdown,
          pages: pages.map((p) => ({ page: p.page, markdown: p.markdown, blocks: p.blocks })),
          stats: res.stats,
        },
        null,
        2,
      )
    : markdown;
  if (out) await writeFile(out, text + '\n');
  else process.stdout.write(text + '\n');
  if (!quiet) {
    const s = res.stats;
    process.stderr.write(
      `\n${s.pages} page(s) · native ${Math.round(s.nativeDoneMs)} ms · total ${Math.round(s.totalMs)} ms · ${s.ocrRegions} OCR region(s)\n`,
    );
  }
} catch (err) {
  process.stderr.write(`pdffr: ${err?.message || err}\n`);
  process.exitCode = 1;
} finally {
  await terminateOcr();
}
