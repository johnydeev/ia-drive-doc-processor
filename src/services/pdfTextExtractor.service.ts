import { PDFParse } from "pdf-parse";

export class PdfTextExtractorService {
  async extractTextFromPdf(buffer: Buffer): Promise<string> {
    const directText = await this.extractTextDirectly(buffer);
    if (directText.length > 0) {
      return directText;
    }

    // OCR stack is loaded only when needed to keep baseline path lightweight.
    const { OcrService } = await import("@/services/ocr.service");
    const ocrService = new OcrService();
    const ocrText = await ocrService.extractTextFromPdf(buffer);

    return this.cleanText(ocrText);
  }

  private async extractTextDirectly(buffer: Buffer): Promise<string> {
    const parser = new PDFParse({ data: buffer });

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
