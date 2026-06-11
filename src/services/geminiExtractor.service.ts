import { GoogleGenerativeAI, GenerativeModel, GenerateContentResult } from "@google/generative-ai";
import { env } from "@/config/env";
import {
  buildExtractionPrompt,
  parseExtractionOutput,
  refineExtractionWithRawText,
} from "@/lib/extraction";
import { AiUsageMetrics } from "@/types/aiUsage.types";
import { AiExtractor } from "@/services/aiExtraction";
import { callWithRetry } from "@/lib/aiErrors";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";

/**
 * Modelo por defecto si el cliente no configura uno (GEMINI_MODEL / options.model).
 *
 * IMPORTANTE: se usa UN SOLO modelo por llamada (configurable). Antes se barría
 * una lista de 6 modelos y, ante un 429 (rate-limit de cuota), se reintentaba con
 * cada uno → 6× consumo de cuota por boleta, agotándola en pocas boletas. Un 429
 * es del proyecto/cuota, no del modelo: probar otro modelo no ayuda. Ahora se usa
 * 1 modelo + backoff acotado (callWithRetry) y, si persiste el 429, se propaga
 * como RateLimitError para que el pipeline deje la boleta en Pendientes.
 */
const DEFAULT_MODEL = "gemini-2.5-flash-lite";

/** Reintentos/backoff ante rate-limit (acotado: no derrochar cuota). */
const RATE_LIMIT_RETRIES = 1;
const RATE_LIMIT_BACKOFF_MS = 3000;

export class GeminiExtractorService implements AiExtractor {
  readonly provider = "gemini" as const;
  private readonly genAI: GoogleGenerativeAI;
  private readonly preferredModel?: string;
  private lastUsage: AiUsageMetrics | null = null;

  constructor(options?: { apiKey?: string; model?: string }) {
    const apiKey = options?.apiKey?.trim() || env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not configured");
    }

    this.genAI = new GoogleGenerativeAI(apiKey);
    this.preferredModel = options?.model?.trim() || env.GEMINI_MODEL?.trim() || undefined;
  }

  /** Único modelo a usar (configurable). */
  private resolveModelName(): string {
    return this.preferredModel ?? DEFAULT_MODEL;
  }

  private getModel(modelName: string): GenerativeModel {
    return this.genAI.getGenerativeModel({ model: modelName });
  }

  private captureUsage(modelName: string, result: GenerateContentResult): void {
    const usageMetadata = (
      result.response as unknown as {
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          totalTokenCount?: number;
        };
      }
    ).usageMetadata;

    const inputTokens = Number(usageMetadata?.promptTokenCount ?? 0);
    const outputTokens = Number(usageMetadata?.candidatesTokenCount ?? 0);
    const totalTokens = Number(usageMetadata?.totalTokenCount ?? inputTokens + outputTokens);

    this.lastUsage = {
      provider: "gemini",
      model: modelName,
      inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
      outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
      totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    };
  }

  async extractStructuredData(text: string): Promise<ExtractedDocumentData> {
    if (!text.trim()) {
      throw new Error("No text provided for Gemini extraction");
    }

    this.lastUsage = null;
    const prompt = buildExtractionPrompt(text);
    const modelName = this.resolveModelName();

    return callWithRetry(
      async () => {
        const model = this.getModel(modelName);
        const result = await model.generateContent({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        });
        const outputText = result.response.text() || "{}";
        const parsed = parseExtractionOutput(outputText);
        const refined = refineExtractionWithRawText(parsed, text);
        this.captureUsage(modelName, result);
        return refined;
      },
      { retries: RATE_LIMIT_RETRIES, backoffMs: RATE_LIMIT_BACKOFF_MS }
    );
  }

  getLastUsage(): AiUsageMetrics | null {
    return this.lastUsage;
  }

  async extractProviderFromImage(
    pngBuffer: Buffer,
    consortiumName: string
  ): Promise<{ providerName: string | null; providerTaxId: string | null }> {
    const base64Image = pngBuffer.toString("base64");
    const prompt = [
      "Sos un asistente especializado en facturas argentinas.",
      "En la imagen hay una factura. El consorcio receptor ya fue identificado",
      `como "${consortiumName}".`,
      "Tu única tarea es identificar al EMISOR de la factura (quien factura,",
      "no quien recibe). Buscá en el bloque superior izquierdo o superior",
      "derecho donde aparece la razón social y CUIT del emisor.",
      "",
      "Respondé SOLO con un JSON sin texto adicional:",
      '{ "providerName": "RAZÓN SOCIAL DEL EMISOR o null", "providerTaxId": "XX-XXXXXXXX-X o null" }',
      "",
      "IMPORTANTE:",
      "- providerTaxId debe ser el CUIT del EMISOR, no del receptor/consorcio.",
      `- El CUIT del consorcio receptor es diferente — NO lo uses.`,
      "- Si no podés identificar el emisor con certeza, devolvé null en ambos campos.",
      "- No inventes datos.",
    ].join("\n");

    const contents = [{
      role: "user" as const,
      parts: [
        { inlineData: { mimeType: "image/png" as const, data: base64Image } },
        { text: prompt },
      ],
    }];

    // Fallback liviano: 1 modelo, sin reintentos. Si falla, devolvemos null.
    try {
      const model = this.getModel(this.resolveModelName());
      const result = await model.generateContent({
        contents,
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      });
      const outputText = result.response.text() || "{}";
      const clean = outputText.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean) as { providerName?: string | null; providerTaxId?: string | null };
      return {
        providerName: parsed.providerName ?? null,
        providerTaxId: parsed.providerTaxId ?? null,
      };
    } catch {
      return { providerName: null, providerTaxId: null };
    }
  }

  async extractStructuredDataFromImage(
    imageBuffer: Buffer,
    mimeType: "image/jpeg" | "image/png"
  ): Promise<ExtractedDocumentData> {
    this.lastUsage = null;
    const base64Image = imageBuffer.toString("base64");
    const prompt = buildExtractionPrompt("__IMAGE_INPUT__");
    const visualPrompt = prompt.replace(
      /Texto de la factura:[\s\S]*$|Texto del recibo:[\s\S]*$|Texto relevante:[\s\S]*$/,
      "La factura/documento está en la imagen adjunta. Extraé todos los datos según las reglas anteriores."
    );

    const contents = [{
      role: "user" as const,
      parts: [
        { inlineData: { mimeType, data: base64Image } },
        { text: visualPrompt },
      ],
    }];

    const modelName = this.resolveModelName();

    return callWithRetry(
      async () => {
        const model = this.getModel(modelName);
        const result = await model.generateContent({
          contents,
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        });
        const outputText = result.response.text() || "{}";
        const parsed = parseExtractionOutput(outputText);
        const refined = refineExtractionWithRawText(parsed, "");
        this.captureUsage(modelName, result);
        return refined;
      },
      { retries: RATE_LIMIT_RETRIES, backoffMs: RATE_LIMIT_BACKOFF_MS }
    );
  }
}
