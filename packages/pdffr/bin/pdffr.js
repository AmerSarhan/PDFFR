#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { decompileFile, terminateOcr } from '../dist/node.js';

const HELP = `pdffr — PDF → Markdown decompiler

usage: pdffr <file.pdf> [options]

  -o, --out <file>   write markdown to a file instead of stdout
  --no-ocr           never rasterize; native text only
  --lang <codes>     tesseract language(s), e.g. eng, deu, eng+ara (default eng)
  -q, --quiet        no progress on stderr
  -h, --help         this text
`;

const args = process.argv.slice(2);
let file = '';
let out = '';
let ocr = true;
let lang = 'eng';
let quiet = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-h' || a === '--help') {
    process.stdout.write(HELP);
    process.exit(0);
  } else if (a === '-o' || a === '--out') out = args[++i] || '';
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

try {
  const res = await decompileFile(file, {
    ocr,
    lang,
    onEvent: quiet
      ? undefined
      : (e) => e.type === 'trace' && process.stderr.write(`${e.kind.padEnd(6)} ${e.msg}\n`),
  });
  if (out) await writeFile(out, res.markdown + '\n');
  else process.stdout.write(res.markdown + '\n');
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
