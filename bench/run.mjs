/**
 * Benchmark: pdffr against the open-source PDF→text/Markdown tools people reach for, on the
 * four sample PDFs, scored against hand-written reference Markdown in bench/reference/.
 *
 *   npm run bench            → writes docs/benchmark.md
 *
 * Scores are recall against the reference: headings (a `#` line with the same text), table
 * rows (the same `| a | b |` line), list items (the same `- item` line), reading order (share of
 * consecutive reference paragraphs that appear in the same order in the output) and words
 * (share of the reference's distinct words that appear anywhere in the output). Plain-text
 * tools score 0 on structure by construction — that is the point being measured — while their
 * word recall shows how much text they got out at all.
 *
 * Cloud parsers are not run here: they need accounts. Add one in `tools` if you have a key.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { decompile, terminateOcr } from 'pdffr/node';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdf2md from '@opendocsg/pdf2md';

const run = promisify(execFile);

const SAMPLES = [
  {
    id: 'report',
    ocr: false,
    note: 'born-digital: headings, inline bold, list, table, two-column page, running header + page numbers',
  },
  {
    id: 'gaps',
    ocr: false,
    note: 'born-digital: ruled table with a multi-line cell, rotated sidebar, inline + display math',
  },
  { id: 'mixed', ocr: true, note: 'native page + full-page scan + native page with a scanned insert' },
  { id: 'scan', ocr: true, note: 'full-page scan, no text layer at all' },
];

const bytesOf = async (id) => {
  const b = await readFile(`demo/public/samples/${id}.pdf`);
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
};

const tools = {
  pdffr: async (bytes, { ocr }) => (await decompile(bytes.slice(), { ocr })).markdown,
  'pdf.js text': async (bytes) => {
    const doc = await pdfjs.getDocument({
      data: bytes.slice(),
      standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/',
    }).promise;
    let out = '';
    for (let p = 1; p <= doc.numPages; p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      for (const it of tc.items) out += it.str + (it.hasEOL ? '\n' : '');
      out += '\n\n';
    }
    await doc.loadingTask.destroy();
    return out;
  },
  // pdf-parse carries its own pdf.js build; it runs in a child process and reports its own timing
  'pdf-parse': async (_bytes, { id }) => {
    const { stdout } = await run('node', ['bench/pdf-parse-child.mjs', `demo/public/samples/${id}.pdf`], {
      maxBuffer: 64 << 20,
    });
    const r = JSON.parse(stdout);
    return Object.assign(new String(r.text), { ms: r.ms });
  },
  pdf2md: async (bytes) => pdf2md(Buffer.from(bytes)),
};

/* ---------- scoring ---------- */
const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const words = (s) =>
  new Set(
    norm(s)
      .replace(/[^\p{L}\p{N} ]/gu, ' ')
      .split(' ')
      .filter((w) => w.length > 1),
  );
const lines = (s) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function score(ref, out) {
  const refLines = lines(ref);
  const outNorm = new Set(lines(out).map(norm));
  const has = (l) => outNorm.has(norm(l));
  const recall = (arr) => (arr.length ? arr.filter(has).length / arr.length : null);
  const headings = refLines.filter((l) => /^#{1,6}\s/.test(l));
  const rows = refLines.filter((l) => /^\|/.test(l) && !/^\|[\s|:-]+\|$/.test(l));
  const items = refLines.filter((l) => /^-\s/.test(l));
  // reading order: first five words of each reference paragraph, in sequence
  const paras = ref
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^[#|\-$]/.test(p))
    .map((p) =>
      norm(p)
        .replace(/[*_`<>]/g, '')
        .split(' ')
        .slice(0, 5)
        .join(' '),
    );
  const flat = norm(out).replace(/[*_`<>]/g, '');
  // order is judged only over the paragraphs that were found at all; missing text is the words score's job
  const found = paras.map((key) => flat.indexOf(key)).filter((i) => i >= 0);
  let ordered = 0;
  const pairs = Math.max(0, found.length - 1);
  for (let k = 1; k < found.length; k++) if (found[k] > found[k - 1]) ordered++;
  const rw = words(ref);
  const ow = words(out);
  let hit = 0;
  for (const w of rw) if (ow.has(w)) hit++;
  return {
    headings: recall(headings),
    rows: recall(rows),
    items: recall(items),
    order: pairs ? ordered / pairs : null,
    words: rw.size ? hit / rw.size : 0,
  };
}

/* ---------- run ---------- */
const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
const pct = (v) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const ms = (v) => (v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`);

const results = [];
for (const s of SAMPLES) {
  const bytes = await bytesOf(s.id);
  const ref = await readFile(`bench/reference/${s.id}.md`, 'utf8');
  const row = { sample: s, tools: {} };
  for (const [name, fn] of Object.entries(tools)) {
    const times = [];
    let out = '';
    let error = '';
    const runs = name === 'pdffr' && s.ocr ? 2 : 3; // OCR runs once warm; the first includes worker start-up
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      let selfTimed = null;
      try {
        const r = await fn(bytes, s);
        if (r && typeof r.ms === 'number') selfTimed = r.ms;
        out = String(r);
      } catch (e) {
        error = String(e?.message || e).split('\n')[0];
        out = '';
      }
      times.push(selfTimed ?? performance.now() - t0);
    }
    row.tools[name] = {
      ms: name === 'pdffr' && s.ocr ? times[times.length - 1] : median(times),
      out,
      error,
      score: score(ref, out),
    };
    process.stderr.write(
      `${s.id.padEnd(7)} ${name.padEnd(12)} ${ms(row.tools[name].ms).padStart(9)}  words ${pct(row.tools[name].score.words)}${error ? '  ERROR ' + error : ''}\n`,
    );
  }
  results.push(row);
}
await terminateOcr();

/* ---------- report ---------- */
const versions = {};
for (const p of ['pdffr', 'pdf-parse', '@opendocsg/pdf2md', 'pdfjs-dist', 'tesseract.js']) {
  versions[p] = JSON.parse(await readFile(`node_modules/${p}/package.json`, 'utf8')).version;
}
const cpu = cpus()[0]?.model || 'unknown CPU';
let md = `# Benchmark

Generated by \`npm run bench\` on ${new Date().toISOString().slice(0, 10)} · Node ${process.version} · ${cpu} · ${cpus().length} cores.

Four sample PDFs (in \`demo/public/samples/\`), each scored against hand-written reference Markdown in \`bench/reference/\`. Times are the median of 3 runs for text tools; for pdffr on scanned samples the second run, after the OCR workers are warm (the first run adds ~1–3 s of worker start-up).

**Read the scores for what they are.** The samples are synthetic and the references were written by the pdffr author, so this measures the *kind* of thing each tool produces, not accuracy on your documents. pdf.js text and pdf-parse do not attempt structure, so they score 0 on headings, tables and lists by construction; their word recall shows how much text they recover. Cloud parsers (LlamaParse, Textract, Document AI) are not included because they need accounts — add one to \`bench/run.mjs\` if you have a key and re-run.

Columns: **headings / rows / items** — share of the reference's headings, table rows and list items reproduced exactly; **order** — share of consecutive reference paragraphs that appear in the same order; **words** — share of the reference's distinct words present anywhere in the output.

`;
for (const r of results) {
  md += `## ${r.sample.id}.pdf\n\n_${r.sample.note}_\n\n| Tool | Time | Headings | Table rows | List items | Order | Words |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n`;
  for (const [name, t] of Object.entries(r.tools)) {
    const sc = t.score;
    md += `| ${name} | ${ms(t.ms)} | ${pct(sc.headings)} | ${pct(sc.rows)} | ${pct(sc.items)} | ${pct(sc.order)} | ${pct(sc.words)} |${t.error ? ` ⚠ ${t.error}` : ''}\n`;
  }
  md += '\n';
}
md += `## What the outputs look like\n\nThe first lines of each tool's output for \`report.pdf\` — the difference between "text" and "document" is the whole argument.\n\n`;
for (const [name, t] of Object.entries(results[0].tools)) {
  const excerpt = lines(t.out).slice(0, 10).join('\n');
  md += `**${name}**\n\n\`\`\`\n${excerpt || '(no output)'}\n\`\`\`\n\n`;
}
md += `## Versions\n\n${Object.entries(versions)
  .map(([k, v]) => `- ${k} ${v}`)
  .join('\n')}\n\n## Reproduce\n\n\`\`\`bash\nnpm install\nnpm run build:lib\nnpm run bench\n\`\`\`\n`;
await writeFile('docs/benchmark.md', md);
process.stderr.write('\nwrote docs/benchmark.md\n');
