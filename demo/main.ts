import './style.css';
import * as pdfjs from 'pdfjs-dist';
import { setPdfWorkerSrc } from '../src/engine/pdf';
import { runPipeline } from '../src/engine/pipeline';
import { OcrPool } from '../src/engine/ocr';
import { blocksToMarkdown } from '../src/engine/markdown';
import { buildLines, orderRuns } from '../src/engine/layout';
import type { Block, PageState, PipelineEvent, Stats } from '../src/engine/types';

setPdfWorkerSrc(new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pagesEl = $('pages');
const hintEl = $('hint');
const renderedEl = $('rendered');
const sourceEl = $<HTMLPreElement>('source');
const statusEl = $('statusText');
const logEl = $('log');
const fileInput = $<HTMLInputElement>('file');

/* ---------- theme ---------- */
const root = document.documentElement;
try {
  const t = localStorage.getItem('pdffr-theme');
  if (t) root.setAttribute('data-theme', t);
  else if (matchMedia('(prefers-color-scheme: dark)').matches) root.setAttribute('data-theme', 'dark');
} catch {
  /* private mode */
}
$('theme').onclick = () => {
  const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  try {
    localStorage.setItem('pdffr-theme', next);
  } catch {
    /* ignore */
  }
};

/* ---------- OCR pool, warmed while the user is still choosing a file ---------- */
const pool = new OcrPool();
pool.onStatus = (s) => log('info', s, 0);
(window as any).requestIdleCallback
  ? (window as any).requestIdleCallback(() => pool.warm())
  : setTimeout(() => pool.warm(), 800);

/* ---------- state ---------- */
const pageBlocks = new Map<number, Block[]>();
const pageStates = new Map<number, PageState>();
const pageEls = new Map<number, { wrap: HTMLElement; svg: SVGSVGElement }>();
let nPages = 0;
let running = false;
let currentName = '';
let view: 'rendered' | 'source' = 'rendered';
let viewerDoc: pdfjs.PDFDocumentProxy | null = null;

function esc(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}
function fullMarkdown(): string {
  const parts: string[] = [];
  for (let p = 1; p <= nPages; p++) {
    const b = pageBlocks.get(p);
    if (b && b.length) parts.push(blocksToMarkdown(b));
  }
  return parts.join('\n\n');
}

/* ---------- output: rendered document ---------- */
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
  let prev = -1;
  for (const it of items) {
    const level = Math.min(it.level, prev + 1);
    prev = level;
    while (stack.length > level + 1) html += `</li></${stack.pop()}>`;
    if (stack.length === level + 1) html += '</li>';
    while (stack.length < level + 1) {
      const tag = it.ordered ? 'ol' : 'ul';
      html += `<${tag}>`;
      stack.push(tag);
      if (stack.length < level + 1) html += '<li>';
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
    if (nPages > 1) html += `<div class="pgsep" id="md-p${p}">page ${p}</div>`;
    for (const b of blocks) {
      if (b.type === 'heading') html += `<h${b.level}>${inline(b.text)}</h${b.level}>`;
      else if (b.type === 'para') html += `<p>${inline(b.text)}</p>`;
      else if (b.type === 'list') html += nestedList(b.items);
      else if (b.type === 'table') {
        html +=
          '<table>' +
          b.rows
            .map(
              (r, i) =>
                '<tr>' +
                r.map((c) => `<${i ? 'td' : 'th'}>${inline(c)}</${i ? 'td' : 'th'}>`).join('') +
                '</tr>',
            )
            .join('') +
          '</table>';
      } else html += `<p class="pending">${esc(b.label)}</p>`;
    }
  }
  renderedEl.innerHTML = html || '<p class="empty">The decompiled document appears here.</p>';
}
function paintSource() {
  let html = '';
  for (let p = 1; p <= nPages; p++) {
    const b = pageBlocks.get(p);
    if (!b) continue;
    if (nPages > 1) html += `<span class="pg" id="src-p${p}"># page ${p}</span>`;
    html +=
      blocksToMarkdown(b)
        .split('\n')
        .map((l) => {
          const e = esc(l);
          if (/^#{1,6}\s/.test(l)) return `<span class="h">${e}</span>`;
          if (/^<!--/.test(l)) return `<span class="cm">${e}</span>`;
          return e;
        })
        .join('\n') + '\n';
  }
  sourceEl.innerHTML = html || '<span class="empty">The markdown source appears here.</span>';
}
function paint() {
  if (view === 'rendered') paintRendered();
  else paintSource();
}
function setView(v: typeof view) {
  view = v;
  $('vRendered').classList.toggle('on', v === 'rendered');
  $('vSource').classList.toggle('on', v === 'source');
  renderedEl.hidden = v !== 'rendered';
  sourceEl.hidden = v !== 'source';
  paint();
}
$('vRendered').onclick = () => setView('rendered');
$('vSource').onclick = () => setView('source');

$('copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(fullMarkdown());
  } catch {
    /* clipboard unavailable */
  }
  const b = $('copy');
  b.classList.add('ok');
  b.textContent = 'Copied';
  setTimeout(() => {
    b.classList.remove('ok');
    b.textContent = 'Copy';
  }, 1400);
};
$('dl').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([fullMarkdown()], { type: 'text/markdown' }));
  a.download = (currentName || 'document').replace(/\.pdf$/i, '') + '.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

/* ---------- page viewer with overlays ---------- */
const SVG = 'http://www.w3.org/2000/svg';

async function openViewer(data: ArrayBuffer) {
  await viewerDoc?.loadingTask.destroy();
  pagesEl.querySelectorAll('.page').forEach((e) => e.remove());
  pageEls.clear();
  viewerDoc = await pdfjs.getDocument({ data: data.slice(0) }).promise;
  hintEl.hidden = true;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target as HTMLElement;
        observer.unobserve(el);
        void renderThumb(Number(el.dataset.page), el);
      }
    },
    { root: pagesEl, rootMargin: '600px' },
  );
  for (let p = 1; p <= viewerDoc.numPages; p++) {
    const page = await viewerDoc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const wrap = document.createElement('div');
    wrap.className = 'page busy';
    wrap.dataset.page = String(p);
    wrap.style.aspectRatio = `${vp.width} / ${vp.height}`;
    const canvas = document.createElement('canvas');
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', `0 0 ${vp.width} ${vp.height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(p);
    wrap.append(canvas, svg, num);
    wrap.onclick = () =>
      document
        .getElementById(`${view === 'rendered' ? 'md' : 'src'}-p${p}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    pagesEl.appendChild(wrap);
    pageEls.set(p, { wrap, svg });
    // short documents paint every page up front; long ones paint as they scroll into view
    if (viewerDoc.numPages <= 12) void renderThumb(p, wrap);
    else observer.observe(wrap);
    drawOverlay(p);
  }
}

async function renderThumb(p: number, wrap: HTMLElement) {
  if (!viewerDoc) return;
  const page = await viewerDoc.getPage(p);
  const canvas = wrap.querySelector('canvas')!;
  const cssW = wrap.clientWidth || 560;
  const scale = (cssW * Math.min(2, devicePixelRatio || 1)) / page.getViewport({ scale: 1 }).width;
  const vp = page.getViewport({ scale });
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d')!;
  await page.render({ canvasContext: ctx, canvas, viewport: vp, intent: 'print' } as any).promise;
  wrap.classList.remove('busy');
  wrap.style.aspectRatio = '';
}

function rect(cls: string, x: number, y: number, w: number, h: number) {
  const r = document.createElementNS(SVG, 'rect');
  r.setAttribute('class', cls);
  r.setAttribute('x', String(x));
  r.setAttribute('y', String(y));
  r.setAttribute('width', String(Math.max(0, w)));
  r.setAttribute('height', String(Math.max(0, h)));
  return r;
}
function drawOverlay(p: number) {
  const el = pageEls.get(p);
  const st = pageStates.get(p);
  if (!el || !st) return;
  const { svg } = el;
  svg.replaceChildren();
  // native text: what came free
  for (const ln of buildLines(st.native))
    svg.appendChild(rect('nat', ln.x0, ln.y0, ln.x1 - ln.x0, ln.y1 - ln.y0));
  // OCR regions and their fate
  const done = new Map(st.ocr.map((o) => [o.region, o]));
  for (const r of st.regions) {
    const o = done.get(r);
    const cls = !o ? 'pending' : o.rejected ? 'reject' : 'done';
    svg.appendChild(rect(`reg ${cls}`, r.x, r.y, r.w, r.h));
    const label = !o ? 'OCR' : o.rejected ? 'graphics' : `${o.runs.length} words`;
    // label geometry is relative to page width so it reads the same on a 612pt letter and a 1700pt scan
    const u = st.width / 612;
    const th = 12 * u;
    const tw = (label.length * 5.6 + 8) * u;
    const g = document.createElementNS(SVG, 'g');
    const bg = rect(`tagbg ${cls}`, r.x, Math.max(0, r.y - th), tw, th);
    const t = document.createElementNS(SVG, 'text');
    t.setAttribute('class', 'tag');
    t.setAttribute('x', String(r.x + 4 * u));
    t.setAttribute('y', String(Math.max(0, r.y - th) + 9 * u));
    t.setAttribute('font-size', String(9 * u));
    t.textContent = label;
    g.append(bg, t);
    svg.appendChild(g);
  }
}

/* ---------- log + status ---------- */
function log(kind: string, msg: string, t: number) {
  const row = document.createElement('div');
  row.className = 'row';
  const time = t ? (t < 1000 ? `${Math.round(t)} ms` : `${(t / 1000).toFixed(2)} s`) : '';
  row.innerHTML = `<span class="t">${time}</span><span class="k ${kind}">${kind}</span><span>${esc(msg)}</span>`;
  logEl.appendChild(row);
  logEl.scrollTop = logEl.scrollHeight;
}
$('logToggle').onclick = () => {
  logEl.hidden = !logEl.hidden;
  $('logToggle').textContent = logEl.hidden ? 'Show log' : 'Hide log';
};
const fmt = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);
function status(s: Stats, final: boolean) {
  const parts = [`${currentName}`, `${s.pages} page${s.pages > 1 ? 's' : ''}`];
  if (s.firstOutputMs) parts.push(`first output ${fmt(s.firstOutputMs)}`);
  if (final) {
    parts.push(`done in ${fmt(s.totalMs)}`);
    if (s.ocrRegions) parts.push(`${s.ocrRegions} region${s.ocrRegions > 1 ? 's' : ''} sent to OCR`);
    else parts.push('no OCR needed');
  } else if (s.ocrRegions) parts.push(`OCR ${s.ocrDone} of ${s.ocrRegions} regions`);
  else parts.push('decompiling…');
  statusEl.textContent = parts.join(' · ');
}

/* ---------- run ---------- */
async function run(buf: ArrayBuffer, name: string) {
  if (running) return;
  running = true;
  currentName = name;
  pageBlocks.clear();
  pageStates.clear();
  nPages = 0;
  logEl.replaceChildren();
  paint();
  statusEl.textContent = `Opening ${name}…`;
  const viewer = openViewer(buf.slice(0));
  const onEvent = (e: PipelineEvent) => {
    if (e.type === 'trace') log(e.kind, e.msg, e.t);
    else if (e.type === 'page') {
      pageBlocks.set(e.page, e.blocks);
      pageStates.set(e.page, e.state);
      paint();
      drawOverlay(e.page);
    } else if (e.type === 'stats') {
      nPages = e.stats.pages;
      status(e.stats, false);
    } else if (e.type === 'done') status(e.stats, true);
  };
  try {
    await runPipeline(buf, onEvent, { ocr: pool, escalate: true, concurrency: 4 });
  } catch (err: any) {
    log('warn', `failed: ${String(err?.message || err)}`, 0);
    statusEl.textContent = `Could not read ${name} — is it a valid PDF?`;
  } finally {
    running = false;
    await viewer.catch(() => {});
    for (const p of pageStates.keys()) drawOverlay(p);
  }
}
async function handleFile(file: File) {
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    statusEl.textContent = `${file.name} is not a PDF.`;
    return;
  }
  run(await file.arrayBuffer(), file.name);
}
fileInput.onchange = () => {
  const f = fileInput.files?.[0];
  if (f) handleFile(f);
  fileInput.value = '';
};
document.querySelectorAll<HTMLButtonElement>('.samples .lnk').forEach((b) => {
  b.onclick = async () => {
    const src = b.dataset.src!;
    const res = await fetch(src);
    run(await res.arrayBuffer(), src.split('/').pop()!);
  };
});

/* drag & drop anywhere */
const veil = $('dropveil');
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth++;
  veil.hidden = false;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    veil.hidden = true;
  }
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  veil.hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f) handleFile(f);
});

/* open in a working state */
paint();
fetch('/samples/report.pdf')
  .then((r) => r.arrayBuffer())
  .then((b) => run(b, 'report.pdf'))
  .catch(() => {});

// console / automation hook: window.pdffr.load('/samples/mixed.pdf')
(window as any).pdffr = {
  load: async (url: string) => {
    const r = await fetch(url);
    await run(await r.arrayBuffer(), url.split('/').pop()!);
    return fullMarkdown();
  },
  markdown: fullMarkdown,
  states: pageStates,
  engine: { buildLines, orderRuns },
};
