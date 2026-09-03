import { Document, FileReader } from '@llamaindex/core/schema';
import { decompile, type DecompileOptions } from 'pdffr/node';

export interface PdffrReaderOptions {
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
 * LlamaIndex.TS reader backed by pdffr. Each page becomes a Document whose text is
 * Markdown — headings, lists, tables and math survive into the nodes.
 * Use with SimpleDirectoryReader: `fileExtToReader: { pdf: new PdffrReader() }`.
 */
export class PdffrReader extends FileReader<Document> {
  constructor(private readonly options: PdffrReaderOptions = {}) {
    super();
  }

  async loadDataAsContent(fileContent: Uint8Array, filename?: string): Promise<Document[]> {
    const opts: DecompileOptions = {
      ocr: this.options.ocr ?? true,
      lang: this.options.lang,
      concurrency: this.options.concurrency,
    };
    const bytes = new Uint8Array(fileContent.buffer, fileContent.byteOffset, fileContent.byteLength);
    const result = await decompile(bytes, opts);
    const base: Record<string, unknown> = { file_path: filename ?? '', totalPages: result.stats.pages };
    if (this.options.splitPages === false) {
      return [
        new Document({
          text: result.markdown,
          metadata: { ...base, ocrRegions: result.stats.ocrRegions, nativeChars: result.stats.nativeChars },
        }),
      ];
    }
    return result.pages
      .filter((p) => p.markdown)
      .map(
        (p) =>
          new Document({
            text: p.markdown,
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
