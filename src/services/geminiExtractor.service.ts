import { GoogleGenerativeAI, GenerativeModel, GenerateContentResult } from "@google/generative-ai";
import { env } from "@/config/env";
import {
  buildExtractionPrompt,
  parseExtractionOutput,
  refineExtractionWithRawText,
} from "@/lib/extraction";
import { AiUsageMetrics } from "@/types/aiUsage.types";
import { AiExtractor } from "@/services/aiExtraction";
import { isRateLimitError, RateLimitError } from "@/lib/aiErrors";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";

/**
 * Lista de modelos candidatos (barrido por baldes de cuota).
 *
 * CONTEXTO (2026-06-11, confirmado en logs de prod): el free tier de Gemini tiene
 * cuota DIARIA POR MODELO ("GenerateRequestsPerDayPerProjectPerModel-FreeTier",
 * p. ej. limit=20 para 2.5-flash-lite). Un 429 de un modelo NO consume cuota y NO
 * implica que los demás estén agotados: cada modelo es un balde independiente.
 * Por eso el barrido de modelos SUMA los baldes diarios (~N×20 boletas/día) y es
 * la estrategia correcta en free tier.
 *
 * Lo que se conserva del fix anti-429: si TODOS los modelos están sin cuota, se
 * lanza RateLimitError → el pipeline devuelve la boleta a Pendientes (no se
 * pierde, se reintenta en un ciclo posterior). Con tier pago esto deja de ser
 * relevante (la cuota diaria es enorme) y el primer modelo responde siempre.
 */
const DEFAULT_MODEL_CANDIDATES = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-flash-latest",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
];

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    const firstLine = error.message.split("\n")[0]?.trim() ?? error.message;
    const compact = firstLine.length > 220 ? `${firstLine.slice(0, 220)}...` : firstLine;
    const codeMatch = firstLine.match(/\[(\d{3})\s/);
    if (codeMatch) {
      return `HTTP ${codeMatch[1]}: ${compact}`;
    }
    return compact;
  }
  const text = String(error);
  const firstLine = text.split("\n")[0]?.trim() ?? text;
  return firstLine.length > 220 ? `${firstLine.slice(0, 220)}...` : firstLine;
}

export class GeminiExtractorService implements AiExtractor {
  readonly provider = "gemini" as const;
  /** Último modelo que funcionó (compartido entre instancias): arranca el barrido ahí. */
  private static workingModelName: string | null = null;
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

  /**
   * Modelos a probar, en orden: el último que funcionó (evita re-pegar contra un
   * balde ya agotado), el preferido del cliente, y los candidatos por defecto.
   */
  private buildModelCandidates(): string[] {
    const ordered = [
      GeminiExtractorService.workingModelName,
      this.preferredModel,
      ...DEFAULT_MODEL_CANDIDATES,
    ].filter((value): value is string => Boolean(value));
    return [...new Set(ordered)];
  }

  /**
   * Si todos los intentos fallaron, decide qué lanzar: RateLimitError cuando todo
   * fue cuota agotada (la boleta vuelve a Pendientes), o el error agregado.
   */
  private throwSweepFailure(context: string, errors: string[]): never {
    if (errors.length > 0 && errors.every((e) => isRateLimitError(e))) {
      throw new RateLimitError(`${context}: sin cuota en los ${errors.length} modelo(s) del barrido`);
    }
    throw new Error(`${context} failed for all candidate models. ${errors.join(" | ")}`);
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
    const errors: string[] = [];

    for (const modelName of this.buildModelCandidates()) {
      try {
        const model = this.getModel(modelName);
        const result = await model.generateContent({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        });
        const outputText = result.response.text() || "{}";
        const parsed = parseExtractionOutput(outputText);
        const refined = refineExtractionWithRawText(parsed, text);
        this.captureUsage(modelName, result);
        GeminiExtractorService.workingModelName = modelName;
        return refined;
      } catch (error) {
        errors.push(`${modelName}: ${normalizeError(error)}`);
      }
    }

    this.throwSweepFailure("Gemini extraction", errors);
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

    // Fallback liviano (enriquecimiento opcional): barre modelos; si todos
    // fallan devuelve null sin lanzar — el caller sigue sin el dato visual.
    for (const modelName of this.buildModelCandidates()) {
      try {
        const model = this.getModel(modelName);
        const result = await model.generateContent({
          contents,
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        });
        const outputText = result.response.text() || "{}";
        const clean = outputText.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(clean) as { providerName?: string | null; providerTaxId?: string | null };
        GeminiExtractorService.workingModelName = modelName;
        return {
          providerName: parsed.providerName ?? null,
          providerTaxId: parsed.providerTaxId ?? null,
        };
      } catch {
        continue;
      }
    }
    return { providerName: null, providerTaxId: null };
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

    const errors: string[] = [];

    for (const modelName of this.buildModelCandidates()) {
      try {
        const model = this.getModel(modelName);
        const result = await model.generateContent({
          contents,
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        });
        const outputText = result.response.text() || "{}";
        const parsed = parseExtractionOutput(outputText);
        const refined = refineExtractionWithRawText(parsed, "");
        this.captureUsage(modelName, result);
        GeminiExtractorService.workingModelName = modelName;
        return refined;
      } catch (error) {
        errors.push(`${modelName}: ${normalizeError(error)}`);
      }
    }

    this.throwSweepFailure("Gemini Vision image extraction", errors);
  }
}
