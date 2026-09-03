import { readFile } from 'node:fs/promises';
import { BaseDocumentLoader } from '@langchain/core/document_loaders/base';
import { Document } from '@langchain/core/documents';
import { decompile, type DecompileOptions } from 'pdffr/node';

export interface PdffrLoaderOptions {
  /** Escalate ink the text layer cannot explain to on-device OCR. Default true. */
  ocr?: boolean;
  /** Tesseract language(s) for OCR, e.g. 'eng', 'deu', 'eng+ara'. Default 'eng'. */
  lang?: string;
  /** One Document per page (default) or one for the whole file. */
  splitPages?: boolean;
  /** Pages decompiled concurrently. Default 4. */
  concurrency?: number;
}

/**
 * LangChain document loader backed by pdffr. Each page becomes a Document whose
 * pageContent is Markdown — headings, lists, tables and math survive into the chunks.
 */
export class PdffrLoader extends BaseDocumentLoader {
  constructor(
    private readonly input: string | Blob | Uint8Array,
    private readonly options: PdffrLoaderOptions = {},
  ) {
    super();
  }

  async load(): Promise<Document[]> {
    const source = typeof this.input === 'string' ? this.input : 'blob';
    const bytes = await toBytes(this.input);
    const opts: DecompileOptions = {
      ocr: this.options.ocr ?? true,
      lang: this.options.lang,
      concurrency: this.options.concurrency,
    };
    const result = await decompile(bytes, opts);
    const base = { source, totalPages: result.stats.pages };
    if (this.options.splitPages === false) {
      return [
        new Document({
          pageContent: result.markdown,
          metadata: { ...base, ocrRegions: result.stats.ocrRegions, nativeChars: result.stats.nativeChars },
        }),
      ];
    }
    return result.pages
      .filter((p) => p.markdown)
      .map(
        (p) =>
          new Document({
            pageContent: p.markdown,
            metadata: {
              ...base,
              page: p.page,
              ocrRegions: p.state.regions.length,
              nativeChars: p.state.nativeChars,
            },
          }),
      );
  }
}

async function toBytes(input: string | Blob | Uint8Array): Promise<Uint8Array> {
  if (typeof input === 'string') {
    const b = await readFile(input);
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }
  if (input instanceof Uint8Array) return input;
  return new Uint8Array(await input.arrayBuffer());
}
