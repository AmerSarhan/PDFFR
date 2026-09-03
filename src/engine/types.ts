/** A positioned text run. The single IR both native glyphs and OCR words are lowered to. */
export interface Run {
  text: string;
  /** top-left in page units (points), y grows downward */
  x: number;
  y: number;
  w: number;
  h: number;
  /** nominal font size in points */
  size: number;
  bold: boolean;
  italic: boolean;
  /** font name when known (used to spot Symbol/Wingdings bullet glyphs and math fonts) */
  font?: string;
  /** set in a math font, or carrying math symbols */
  math?: boolean;
  /** pre-composed LaTeX for a synthetic run (a folded fraction) */
  tex?: string;
  /** glyph rotation on the page: 0, 90, 180 or 270 degrees */
  rot?: number;
  /** 0–100; native text is 100 */
  conf: number;
  src: 'native' | 'ocr';
}

export interface Line {
  runs: Run[];
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** vertical centre */
  y: number;
  size: number;
  /** plain text */
  text: string;
  /** text with inline markdown (**bold**, *italic*, <sup>, $math$) */
  rich: string;
  /** every run bold */
  bold: boolean;
  /** the whole line is a math expression */
  math: boolean;
}

export interface Table {
  rows: string[][];
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Ruling lines drawn on the page (page units, top-down), used to reconstruct ruled tables. */
export interface Rules {
  h: { y: number; x0: number; x1: number }[];
  v: { x: number; y0: number; y1: number }[];
}

/** A leaf of the reading-order tree: either a run of lines or an atomic table. */
export type Leaf =
  | { kind: 'lines'; lines: Line[]; x0: number; x1: number; y0: number; y1: number; label?: boolean }
  | { kind: 'table'; table: Table; x0: number; x1: number; y0: number; y1: number };

export interface ListItem {
  text: string;
  level: number;
  ordered: boolean;
}

export type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'para'; text: string }
  | { type: 'math'; latex: string }
  | { type: 'list'; items: ListItem[] }
  | { type: 'table'; rows: string[][] }
  | { type: 'pending'; label: string };

/** A rectangle the render-diff oracle flagged for OCR (page units, top-down). */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrResult {
  region: Region;
  runs: Run[];
  meanConf: number;
  /** words re-read at 2× */
  reOcr: number;
  /** region rejected as graphics (no plausible text) */
  rejected: boolean;
}

export interface PageState {
  page: number;
  width: number;
  height: number;
  native: Run[];
  ocr: OcrResult[];
  regions: Region[];
  rules: Rules;
  pendingRegions: number;
  blocks: Block[];
  nativeChars: number;
  ocrChars: number;
  escalated: boolean;
  /** ms spent on this page's native pass */
  nativeMs: number;
}

export type TraceKind = 'info' | 'native' | 'struct' | 'esc' | 'ocr' | 'done' | 'warn';

export interface Stats {
  pages: number;
  /** wall time until the first page had output */
  firstOutputMs: number;
  nativeDoneMs: number;
  totalMs: number;
  blocks: number;
  nativePages: number;
  escPages: number;
  ocrRegions: number;
  ocrDone: number;
  nativeChars: number;
  ocrChars: number;
}

export type PipelineEvent =
  | { type: 'trace'; kind: TraceKind; msg: string; t: number }
  | { type: 'page'; page: number; blocks: Block[]; state: PageState }
  | { type: 'stats'; stats: Stats }
  | { type: 'done'; stats: Stats };
