import { createWorker } from "tesseract.js";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { execSync } from "child_process";
import { writeFileSync, readFileSync, readdirSync, unlinkSync, rmdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export interface OcrOptions {
  scale?: number;
  language?: string;
}

const DEFAULT_LANGUAGE = "spa+eng";

export class OcrService {
  private lastFirstPagePng: Buffer | null = null;

  getLastFirstPagePng(): Buffer | null {
    return this.lastFirstPagePng;
  }

  /**
   * Renderiza SOLO la franja superior (membrete) de la página 1 a alta DPI.
   * En las facturas argentinas el bloque del emisor (razón social + CUIT) suele
   * estar arriba, muchas veces como imagen/logo que `pdf-parse` no lee. Un recorte
   * de esa franja a 300 DPI le da al modelo de visión un CUIT mucho más legible que
   * la página completa a 200 DPI. Devuelve null si falla (el caller decide fallback).
   */
  async renderTopRegionPng(
    buffer: Buffer,
    opts?: { dpi?: number; topFraction?: number }
  ): Promise<Buffer | null> {
    const dpi = opts?.dpi ?? 300;
    const topFraction = Math.min(1, Math.max(0.1, opts?.topFraction ?? 0.4));
    const tmpDir = mkdtempSync(join(tmpdir(), "membrete-"));
    const pdfPath = join(tmpDir, "input.pdf");
    const outputPrefix = join(tmpDir, "page");

    try {
      writeFileSync(pdfPath, buffer);
      // Solo página 1, alta DPI.
      execSync(`pdftoppm -png -r ${dpi} -f 1 -l 1 "${pdfPath}" "${outputPrefix}"`, { timeout: 30000 });
      const files = readdirSync(tmpDir).filter((f) => f.startsWith("page") && f.endsWith(".png")).sort();
      if (files.length === 0) return null;

      const pageBuffer = readFileSync(join(tmpDir, files[0]));
      const img = await loadImage(pageBuffer);
      const cropH = Math.max(1, Math.round(img.height * topFraction));
      const canvas = createCanvas(img.width, cropH);
      const cctx = canvas.getContext("2d");
      cctx.drawImage(img, 0, 0, img.width, cropH, 0, 0, img.width, cropH);
      return canvas.toBuffer("image/png");
    } catch (err) {
      console.warn(`[ocr-service] renderTopRegionPng falló: ${err instanceof Error ? err.message : "?"}`);
      return null;
    } finally {
      try {
        for (const f of readdirSync(tmpDir)) unlinkSync(join(tmpDir, f));
        rmdirSync(tmpDir);
      } catch {
        // Silent cleanup
      }
    }
  }

  async extractTextFromPdf(buffer: Buffer, options?: OcrOptions): Promise<string> {
    this.lastFirstPagePng = null;
    const language = options?.language ?? DEFAULT_LANGUAGE;

    // Crear directorio temporal único
    const tmpDir = mkdtempSync(join(tmpdir(), "ocr-"));
    const pdfPath = join(tmpDir, "input.pdf");
    const outputPrefix = join(tmpDir, "page");

    try {
      // Escribir PDF a disco
      writeFileSync(pdfPath, buffer);

      // Convertir PDF a imágenes PNG usando pdftoppm (200 DPI)
      execSync(`pdftoppm -png -r 200 "${pdfPath}" "${outputPrefix}"`, {
        timeout: 30000,
      });

      // Leer archivos PNG generados (ordenados)
      const files = readdirSync(tmpDir)
        .filter(f => f.startsWith("page") && f.endsWith(".png"))
        .sort();

      if (files.length === 0) {
        console.warn("[ocr-service] pdftoppm no generó imágenes");
        return "";
      }

      // Cachear PNG de la primera página para posible uso en fallback visual
      this.lastFirstPagePng = readFileSync(join(tmpDir, files[0]));

      console.log(`[ocr-service] pdftoppm generó ${files.length} página(s)`);

      // Procesar cada página con Tesseract
      const worker = await createWorker(language);
      let fullText = "";

      try {
        for (const file of files) {
          const imagePath = join(tmpDir, file);
          const imageBuffer = readFileSync(imagePath);
          const { data } = await worker.recognize(imageBuffer);
          if (data?.text) {
            fullText += `${data.text}\n`;
          }
        }
      } finally {
        await worker.terminate();
      }

      console.log(`[ocr-service] OCR completado — ${fullText.length} chars extraídos`);
      return fullText;

    } finally {
      // Limpiar archivos temporales
      try {
        const files = readdirSync(tmpDir);
        for (const file of files) {
          unlinkSync(join(tmpDir, file));
        }
        rmdirSync(tmpDir);
      } catch {
        // Silent cleanup
      }
    }
  }
}
