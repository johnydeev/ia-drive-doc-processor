import { PDFParse } from "pdf-parse";

export class PdfTextExtractorService {
  private static readonly MIN_USEFUL_CHARS = 100;
  private lastOcrPngBuffer: Buffer | null = null;
  private lastHasEmitterBlock = false;
  private lastTextSource: "direct" | "ocr" | "merged" = "direct";
  private lastOcrMs = 0;
  private lastDirectChars = 0;

  getLastOcrPng(): Buffer | null {
    return this.lastOcrPngBuffer;
  }

  /**
   * ¿El PDF de la última llamada era un ESCANEO? (sus páginas son imágenes: no
   * tiene capa de texto propia).
   *
   * Se mide sobre el texto de pdf-parse, NO sobre el resultado final: el OCR
   * puede devolver mucho texto ilegible y tapar la señal. Un PDF escaneado
   * necesita Vision, no la cadena de texto.
   */
  isLastPdfScanned(): boolean {
    return this.lastDirectChars < PdfTextExtractorService.MIN_USEFUL_CHARS;
  }

  getLastHasEmitterBlock(): boolean {
    return this.lastHasEmitterBlock;
  }

  /** Fuente del texto devuelto por la última llamada a extractTextFromPdf. */
  getLastTextSource(): "direct" | "ocr" | "merged" {
    return this.lastTextSource;
  }

  /** Milisegundos que tardó el OCR en la última llamada (0 si no se usó). */
  getLastOcrMs(): number {
    return this.lastOcrMs;
  }

  async extractTextFromPdf(buffer: Buffer, maxPages?: number): Promise<string> {
    this.lastOcrPngBuffer = null;
    this.lastHasEmitterBlock = false;
    this.lastTextSource = "direct";
    this.lastOcrMs = 0;
    const directText = await this.extractTextDirectly(buffer, maxPages);
    this.lastDirectChars = directText.length;

    const hasEnoughText = directText.length >= PdfTextExtractorService.MIN_USEFUL_CHARS;

    // Detectar si el bloque del emisor está presente en el texto
    // buscando etiquetas que solo aparecen en el bloque del emisor AFIP
    const upperText = directText.toUpperCase();
    const hasEmitterBlock = (
      upperText.includes("ING. BRUTOS") ||
      upperText.includes("INGRESOS BRUTOS") ||
      upperText.includes("INICIO DE ACTIVIDADES") ||
      upperText.includes("RESPONSABLE INSCRIPTO") ||
      upperText.includes("MONOTRIBUTO")
    );
    this.lastHasEmitterBlock = hasEmitterBlock;

    console.log(`[pdf-extractor] chars=${directText.length} hasEmitterBlock=${hasEmitterBlock}`);

    if (hasEnoughText && hasEmitterBlock) {
      return directText;
    }

    // Bloque emisor no detectado en texto → intentar OCR
    console.warn(
      `[pdf-extractor] Bloque emisor no detectado en texto ` +
      `(${directText.length} chars, hasEmitterBlock=${hasEmitterBlock}) → activando OCR`
    );
    const ocrStart = Date.now();
    try {
      const { OcrService } = await import("@/services/ocr.service");
      const ocrService = new OcrService();
      const ocrText = await ocrService.extractTextFromPdf(buffer);
      this.lastOcrPngBuffer = ocrService.getLastFirstPagePng();
      const cleanOcr = this.cleanText(ocrText);
      this.lastOcrMs = Date.now() - ocrStart;

      if (cleanOcr.length > directText.length) {
        console.warn(`[pdf-extractor] OCR exitoso — texto enriquecido (${cleanOcr.length} chars)`);
        this.lastTextSource = "merged";
        return this.mergeTexts(directText, cleanOcr);
      }

      if (directText.length > 0) {
        this.lastTextSource = "direct";
        return directText;
      }
      this.lastTextSource = "ocr";
      return cleanOcr;
    } catch (ocrError) {
      this.lastOcrMs = Date.now() - ocrStart;
      this.lastTextSource = "direct";
      console.error(
        `[pdf-extractor] OCR falló, usando texto de pdf-parse: ` +
        `${ocrError instanceof Error ? ocrError.message : "Unknown error"}`
      );
      return directText;
    }
  }

  /**
   * Recorte del membrete (franja superior de la página 1) a alta DPI, para el
   * fallback de visión cuando falta el CUIT del emisor (o del consorcio). On-demand:
   * solo se llama cuando el matching por CUIT no resolvió. Devuelve null si falla.
   */
  async extractMembreteImage(
    buffer: Buffer,
    opts?: { dpi?: number; topFraction?: number }
  ): Promise<Buffer | null> {
    try {
      const { OcrService } = await import("@/services/ocr.service");
      return await new OcrService().renderTopRegionPng(buffer, opts);
    } catch (err) {
      console.error(`[pdf-extractor] extractMembreteImage falló: ${err instanceof Error ? err.message : "?"}`);
      return null;
    }
  }

  private mergeTexts(directText: string, ocrText: string): string {
    if (!directText) return ocrText;
    if (!ocrText) return directText;
    return `${directText}\n\n--- OCR ---\n\n${ocrText}`;
  }

  private async extractTextDirectly(buffer: Buffer, maxPages?: number): Promise<string> {
    const options: Record<string, unknown> = { data: buffer };
    if (maxPages) {
      options.max = maxPages;
    }
    const parser = new PDFParse(options);

    try {
      const parsed = await parser.getText();
      return this.cleanText(parsed.text ?? "");
    } finally {
      await parser.destroy();
    }
  }

  private cleanText(text: string): string {
    return text
      .replace(/\r/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[\t\f\v]+/g, " ")
      .replace(/ {2,}/g, " ")
      .trim();
  }
}
