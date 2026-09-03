import './style.css';
import { setPdfWorkerSrc } from '../src/engine/pdf';
setPdfWorkerSrc(new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href);
import { runPipeline } from '../src/engine/pipeline';
import { OcrPool } from '../src/engine/ocr';
import { blocksToMarkdown } from '../src/engine/markdown';
import type { Block, PipelineEvent, Stats } from '../src/engine/types';
import { buildLines, orderRuns } from '../src/engine/layout';

const app = document.getElementById('app')!;
app.innerHTML = `
<div class="wrap">
  <header>
    <div class="brand">
      <div class="mark">
        <div class="logo" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h9l5 5v11H4z"/><path d="M13 4v5h5"/><path d="M8 13l-2 2 2 2"/><path d="M14 13l2 2-2 2"/></svg></div>
        <div class="wordmark">pdf<b>fr</b></div>
      </div>
      <div class="tag">A PDF <span class="k">decompiler</span>. Native glyph coordinates stream out in milliseconds; a render-diff oracle finds the ink the text layer can't explain and sends <span class="k">only those pixels</span> to on-device OCR.</div>
    </div>
    <div class="toolbar-top">
      <button class="tbtn on" id="escBtn" title="Toggle OCR escalation">◉ OCR escalation</button>
      <button class="tbtn" id="theme" aria-label="Toggle theme">◐ theme</button>
    </div>
  </header>

  <section class="stats" aria-label="Run statistics">
    <div class="stat"><span class="lab">Pages</span><span class="val" id="s-pages">–</span><span class="bar" id="b-pages"></span></div>
    <div class="stat"><span class="lab">First output</span><span class="val" id="s-first">–</span><span class="bar" id="b-first"></span></div>
    <div class="stat"><span class="lab">Total time</span><span class="val" id="s-total">–</span><span class="bar" id="b-total"></span></div>
    <div class="stat"><span class="lab">Blocks</span><span class="val" id="s-blocks">–</span><span class="bar" id="b-blocks"></span></div>
    <div class="stat native"><span class="lab">Native chars</span><span class="val" id="s-native">–</span><span class="bar" id="b-native"></span></div>
    <div class="stat ocr"><span class="lab">OCR regions</span><span class="val" id="s-ocr">–</span><span class="bar" id="b-ocr"></span></div>
  </section>

  <div class="drop" id="drop" tabindex="0" role="button" aria-label="Drop a PDF or click to choose">
    <div class="ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2"/></svg></div>
    <div class="txt">
      <div class="t1" id="dropT1">Drop a PDF here, or click to choose a file</div>
      <div class="t2" id="dropT2">Everything runs in this tab — <code>your file never uploads</code>. <span id="ocrStatus"></span></div>
      <div class="prog" id="prog"><i id="progBar"></i></div>
    </div>
    <div class="cta">Choose file</div>
    <input type="file" id="file" accept="application/pdf,.pdf" hidden>
  </div>
  <div class="samples">try a sample →
    <button class="sample" data-src="/samples/report.pdf"><i class="n"></i> born-digital report</button>
    <button class="sample" data-src="/samples/scan.pdf"><i class="e"></i> scanned page</button>
    <button class="sample" data-src="/samples/mixed.pdf"><i class="m"></i> mixed · native + scanned insert</button>
  </div>

  <div class="grid">
    <section class="panel">
      <div class="phead"><div class="ptitle"><span class="dot"></span> Decompiler trace</div><div class="pill" id="tracePill">idle</div></div>
      <div class="trace" id="trace" aria-live="polite"></div>
    </section>
    <section class="panel">
      <div class="phead">
        <div class="ptitle"><span class="dot g"></span> Markdown output</div>
        <div class="out-tools">
          <div class="seg" role="tablist"><button id="vSrc" class="on" role="tab">source</button><button id="vRender" role="tab">rendered</button></div>
          <button class="copy" id="copy"><span id="copyTxt">copy</span></button>
          <button class="copy" id="dl">download .md</button>
        </div>
      </div>
      <div class="out"><pre class="src" id="src"></pre><div class="rendered" id="rendered"></div></div>
    </section>
  </div>

  <div class="legend">
    <span><i class="s"></i> structure from geometry</span>
    <span><i class="n"></i> native text — free, no model</span>
    <span><i class="e"></i> escalated — ink the text layer can't explain</span>
    <span><i class="o"></i> OCR — on-device tesseract, filled in place</span>
  </div>
  <footer><span class="g">●</span> 100% client-side · pdf.js worker + <span id="wc"></span> tesseract workers · nothing leaves the browser</footer>
</div>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const traceEl = $('trace'), srcEl = $('src'), rndEl = $('rendered'), drop = $('drop');
const fileInput = $<HTMLInputElement>('file'), prog = $('prog'), progBar = $('progBar');
const tracePill = $('tracePill'), ocrStatus = $('ocrStatus');

/* ---------- theme ---------- */
const root = document.documentElement;
try { const t = localStorage.getItem('pdffr-theme'); if (t) root.setAttribute('data-theme', t); } catch { /* private mode */ }
$('theme').onclick = () => {
  const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  root.setAttribute('data-theme', next);
  try { localStorage.setItem('pdffr-theme', next); } catch { /* ignore */ }
};

/* ---------- OCR pool: warmed in the background so a scan never waits for model download ---------- */
const pool = new OcrPool();
$('wc').textContent = String(pool.size);
pool.onStatus = (s) => { ocrStatus.textContent = s; };
let escalate = true;
$('escBtn').onclick = () => {
  escalate = !escalate;
  $('escBtn').classList.toggle('on', escalate);
  $('escBtn').textContent = (escalate ? '◉' : '○') + ' OCR escalation';
};
(window as any).requestIdleCallback ? (window as any).requestIdleCallback(() => pool.warm()) : setTimeout(() => pool.warm(), 800);

/* ---------- output state ---------- */
const pageBlocks = new Map<number, Block[]>();
const debugStates = new Map<number, unknown>();
let nPages = 0;
let running = false;

function fullMarkdown(): string {
  const parts: string[] = [];
  for (let p = 1; p <= nPages; p++) {
    const b = pageBlocks.get(p);
    if (b && b.length) parts.push(blocksToMarkdown(b));
  }
  return parts.join('\n\n');
}
function esc(s: string) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)); }

function paintSource() {
  let html = '';
  for (let p = 1; p <= nPages; p++) {
    const b = pageBlocks.get(p);
    if (!b) continue;
    html += `<span class="pg">page ${p}</span>`;
    html += blocksToMarkdown(b).split('\n').map((l) => {
      const e = esc(l);
      if (/^#{1,6}\s/.test(l)) return `<span class="h">${e}</span>`;
      if (/^\s*([-*]|\d+\.)\s/.test(l)) return `<span class="li">${e}</span>`;
      if (/^\|.*\|/.test(l)) return `<span class="tb">${e}</span>`;
      if (/^<!--/.test(l)) return `<span class="cm">${e}</span>`;
      return e;
    }).join('\n') + '\n';
  }
  srcEl.innerHTML = html || '<div class="empty">Markdown appears here as pages decompile.</div>';
}
function inline(s: string) {
  return esc(s)
    .replace(/&lt;sup&gt;(.+?)&lt;\/sup&gt;/g, '<sup>$1</sup>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+?)\*/g, '$1<em>$2</em>');
}
function nestedList(items: { text: string; level: number; ordered: boolean }[]): string {
  let html = '';
  const stack: string[] = [];
  for (const it of items) {
    while (stack.length > it.level + 1) html += `</li></${stack.pop()}>`;
    if (stack.length === it.level + 1) html += '</li>';
    while (stack.length < it.level + 1) {
      const tag = it.ordered ? 'ol' : 'ul';
      html += `<${tag}>`;
      stack.push(tag);
      if (stack.length < it.level + 1) html += '<li>';
    }
    html += `<li>${inline(it.text)}`;
  }
  while (stack.length) html += `</li></${stack.pop()}>`;
  return html;
}
function paintRendered() {
  let html = '';
  for (let p = 1; p <= nPages; p++) {
    const blocks = pageBlocks.get(p);
    if (!blocks) continue;
    if (p > 1) html += '<hr class="pgsep">';
    for (const b of blocks) {
      if (b.type === 'heading') html += `<h${b.level}>${inline(b.text)}</h${b.level}>`;
      else if (b.type === 'para') html += `<p>${inline(b.text)}</p>`;
      else if (b.type === 'list') html += nestedList(b.items);
      else if (b.type === 'table') {
        html += '<table>' + b.rows.map((r, i) => '<tr>' + r.map((c) => `<${i ? 'td' : 'th'}>${inline(c)}</${i ? 'td' : 'th'}>`).join('') + '</tr>').join('') + '</table>';
      } else html += `<p class="pending">⏳ ${esc(b.label)}</p>`;
    }
  }
  rndEl.innerHTML = html || '<div class="empty">Markdown appears here as pages decompile.</div>';
}
let view: 'src' | 'render' = 'src';
function paint() { if (view === 'src') paintSource(); else paintRendered(); }

$('vSrc').onclick = () => { view = 'src'; $('vSrc').classList.add('on'); $('vRender').classList.remove('on'); srcEl.classList.remove('off'); rndEl.classList.remove('on'); paint(); };
$('vRender').onclick = () => { view = 'render'; $('vRender').classList.add('on'); $('vSrc').classList.remove('on'); srcEl.classList.add('off'); rndEl.classList.add('on'); paint(); };
$('copy').onclick = async () => {
  const md = fullMarkdown();
  try { await navigator.clipboard.writeText(md); } catch { /* no clipboard */ }
  $('copy').classList.add('ok'); $('copyTxt').textContent = 'copied ✓';
  setTimeout(() => { $('copy').classList.remove('ok'); $('copyTxt').textContent = 'copy'; }, 1500);
};
$('dl').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([fullMarkdown()], { type: 'text/markdown' }));
  a.download = (currentName || 'document').replace(/\.pdf$/i, '') + '.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

/* ---------- trace + stats ---------- */
function trace(kind: string, msg: string, t: number) {
  const row = document.createElement('div');
  row.className = 'ev';
  row.innerHTML = `<span class="ts">${t < 1000 ? Math.round(t) + 'ms' : (t / 1000).toFixed(2) + 's'}</span><span class="tt ${kind}">${kind}</span><span class="msg">${esc(msg)}</span>`;
  traceEl.appendChild(row);
  traceEl.scrollTop = traceEl.scrollHeight;
}
const ms = (v: number) => (v < 1000 ? `${Math.round(v)}<span class="u">ms</span>` : `${(v / 1000).toFixed(2)}<span class="u">s</span>`);
function showStats(s: Stats) {
  $('s-pages').textContent = String(s.pages);
  $('s-first').innerHTML = s.firstOutputMs ? ms(s.firstOutputMs) : '–';
  $('s-total').innerHTML = ms(s.totalMs);
  $('s-blocks').textContent = String(s.blocks);
  $('s-native').textContent = s.nativeChars.toLocaleString();
  $('s-ocr').innerHTML = s.ocrRegions ? `${s.ocrDone}<span class="u">/${s.ocrRegions}</span>` : '0';
  $('b-pages').style.width = '100%';
  $('b-first').style.width = '100%';
  $('b-total').style.width = s.ocrRegions ? `${Math.round((s.ocrDone / s.ocrRegions) * 100)}%` : '100%';
  $('b-blocks').style.width = '100%';
  $('b-native').style.width = `${Math.round((s.nativePages / Math.max(1, s.pages)) * 100)}%`;
  $('b-ocr').style.width = s.ocrRegions ? `${Math.round((s.ocrDone / s.ocrRegions) * 100)}%` : '0%';
}

/* ---------- run ---------- */
let currentName = '';
async function run(buf: ArrayBuffer, name: string) {
  if (running) return;
  running = true;
  currentName = name;
  pageBlocks.clear();
  nPages = 0;
  traceEl.innerHTML = '';
  paint();
  tracePill.textContent = 'decompiling'; tracePill.className = 'pill live';
  drop.classList.add('busy'); prog.classList.add('on'); progBar.style.width = '3%';
  $('dropT1').textContent = `Decompiling ${name} …`;
  let pagesSeen = 0;
  const onEvent = (e: PipelineEvent) => {
    if (e.type === 'trace') trace(e.kind, e.msg, e.t);
    else if (e.type === 'page') {
      if (!pageBlocks.has(e.page)) pagesSeen++;
      pageBlocks.set(e.page, e.blocks);
      debugStates.set(e.page, e.state);
      progBar.style.width = `${Math.round((pagesSeen / Math.max(1, nPages)) * 100)}%`;
      paint();
    } else if (e.type === 'stats') { nPages = e.stats.pages; showStats(e.stats); }
    else if (e.type === 'done') { showStats(e.stats); tracePill.textContent = 'complete'; tracePill.className = 'pill ok'; }
  };
  try {
    await runPipeline(buf, onEvent, { ocr: pool, escalate, concurrency: 4 });
    $('dropT1').textContent = `Done — ${name}. Drop another PDF to decompile.`;
  } catch (err: any) {
    trace('warn', `failed: ${String(err?.message || err)}`, 0);
    tracePill.textContent = 'error'; tracePill.className = 'pill';
    $('dropT1').textContent = 'Something went wrong — try another PDF';
  } finally {
    running = false;
    drop.classList.remove('busy');
    setTimeout(() => prog.classList.remove('on'), 600);
  }
}
async function handleFile(file: File) {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { trace('warn', 'not a PDF — drop a .pdf file', 0); return; }
  run(await file.arrayBuffer(), file.name);
}
drop.onclick = () => fileInput.click();
drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } };
fileInput.onchange = () => { const f = fileInput.files?.[0]; if (f) handleFile(f); fileInput.value = ''; };
['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hot'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('hot'); }));
drop.addEventListener('drop', (e) => { const f = (e as DragEvent).dataTransfer?.files?.[0]; if (f) handleFile(f); });
document.querySelectorAll<HTMLButtonElement>('.sample').forEach((b) => {
  b.onclick = async () => {
    const src = b.dataset.src!;
    const res = await fetch(src);
    run(await res.arrayBuffer(), src.split('/').pop()!);
  };
});
paint();

// allow driving from the console / automation: window.pdffr.load('/samples/report.pdf')
(window as any).pdffr = {
  load: async (url: string) => { const r = await fetch(url); await run(await r.arrayBuffer(), url.split('/').pop()!); return fullMarkdown(); },
  markdown: fullMarkdown,
  states: debugStates,
  engine: { buildLines, orderRuns },
};
