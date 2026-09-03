// pdf-parse bundles its own pdf.js; running it in its own process keeps the two pdf.js
// worker versions apart. Prints { ms, text } as JSON. Timing excludes process start-up.
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { PDFParse } from 'pdf-parse';

const b = await readFile(process.argv[2]);
const t0 = performance.now();
const parser = new PDFParse({ data: new Uint8Array(b.buffer, b.byteOffset, b.byteLength) });
const r = await parser.getText();
await parser.destroy();
process.stdout.write(JSON.stringify({ ms: performance.now() - t0, text: r.text }));
