import { GoogleGenerativeAI, GenerativeModel, GenerateContentResult } from "@google/generative-ai";
import { env } from "@/config/env";
import {
  buildExtractionPrompt,
  parseExtractionOutput,
  refineExtractionWithRawText,
} from "@/lib/extraction";
import { AiUsageMetrics } from "@/types/aiUsage.types";
import { AiExtractor } from "@/services/aiExtraction";
import { isRateLimitError, isTransientServerError, RateLimitError } from "@/lib/aiErrors";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";

/**
 * Modelos candidatos del barrido.
 *
 * (2026-06-11, sigue vigente): el free tier tiene cuota DIARIA POR MODELO
 * ("GenerateRequestsPerDayPerProjectPerModel-FreeTier", p. ej. limit=20 para
 * 2.5-flash-lite). Como cada modelo es un balde independiente, barrer SUMA
 * baldes y es la estrategia correcta en free tier. El barrido también cubre el
 * **503 de alta demanda** de Google, que no depende del tier.
 *
 * Se podaron `gemini-2.0-flash` y `gemini-2.0-flash-lite` (2026-08-24): Google
 * los dio de baja y devuelven 404. NO eran baldes de cuota — eran dos intentos
 * garantizados al vacío en cada barrido. Podarlos no reduce la cuota gratis
 * disponible: los tres que quedan son los tres que alguna vez respondieron.
 *
 * Si TODOS los modelos fallan con error transitorio (429 o 503) se lanza
 * `RateLimitError` → el pipeline devuelve la boleta a Pendientes.
 */
const DEFAULT_MODEL_CANDIDATES = [
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-flash-latest",
];

/** Espera antes de reintentar el MISMO modelo tras un 503. */
const TRANSIENT_RETRY_BACKOFF_MS = 2000;

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

export interface GeminiExtractorOptions {
  apiKey?: string;
  model?: string;
  /** Inyectable para tests: evita esperas reales en el reintento del 503. */
  sleep?: (ms: number) => Promise<void>;
}

export class GeminiExtractorService implements AiExtractor {
  readonly provider = "gemini" as const;
  /** Último modelo que funcionó (compartido entre instancias): arranca el barrido ahí. */
  private static workingModelName: string | null = null;
  private readonly genAI: GoogleGenerativeAI;
  private readonly preferredModel?: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastUsage: AiUsageMetrics | null = null;

  constructor(options?: GeminiExtractorOptions) {
    const apiKey = options?.apiKey?.trim() || env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not configured");
    }

    this.genAI = new GoogleGenerativeAI(apiKey);
    this.preferredModel = options?.model?.trim() || env.GEMINI_MODEL?.trim() || undefined;
    this.sleep = options?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Solo para tests: el modelo pegajoso es estático y sobrevive entre casos. */
  static resetWorkingModel(): void {
    GeminiExtractorService.workingModelName = null;
  }

  /** Solo para tests y diagnóstico. */
  static get workingModel(): string | null {
    return GeminiExtractorService.workingModelName;
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
    const allTransient =
      errors.length > 0 &&
      errors.every((e) => isRateLimitError(e) || isTransientServerError(e));

    if (allTransient) {
      throw new RateLimitError(
        `${context}: los ${errors.length} modelo(s) del barrido fallaron por cuota o saturación (429/503)`
      );
    }
    throw new Error(`${context} failed for all candidate models. ${errors.join(" | ")}`);
  }

  /**
   * Fija el modelo pegajoso SOLO si el barrido no tuvo que saltar por un error
   * no-de-cuota.
   *
   * `workingModelName` es `static`: lo comparten todas las instancias del
   * proceso y no expira. Fijarlo tras un salto por 503 dejaba al worker clavado
   * en el modelo al que había saltado hasta el próximo reinicio — y si ese es
   * `2.5-flash`, son 3× el precio del input y 6× el del output de flash-lite,
   * sin que nada lo avise.
   *
   * Ante 429 el pegado SÍ corresponde: la cuota del modelo agotado no se
   * recupera para la boleta siguiente, así que volver a pegarle es gastar un
   * intento seguro al vacío. Esa es la razón por la que el pegado existe.
   */
  private static rememberWorkingModel(modelName: string, previousErrors: string[]): void {
    if (previousErrors.length > 0 && !previousErrors.every((e) => isRateLimitError(e))) return;
    GeminiExtractorService.workingModelName = modelName;
  }

  protected getModel(modelName: string): GenerativeModel {
    return this.genAI.getGenerativeModel({ model: modelName });
  }

  /**
   * Llama a un modelo reintentándolo UNA vez si el error es transitorio (503).
   *
   * Saltar de modelo ante un 503 no está mal —la boleta se resuelve igual— pero
   * la resuelve un modelo distinto del que le tocaba, con otra calidad y otro
   * precio. Un reintento corto sobre el mismo modelo evita esa degradación
   * silenciosa. Un solo reintento: dos sumarían 4 s por modelo, y el peor caso
   * medido en producción ya fue de 187 s.
   *
   * Los errores no transitorios (429, 404, parseo) se propagan sin reintentar:
   * la cuota no vuelve en 2 segundos y un modelo dado de baja no revive.
   */
  private async generateWithTransientRetry(
    modelName: string,
    request: Parameters<GenerativeModel["generateContent"]>[0]
  ): Promise<GenerateContentResult> {
    try {
      return await this.getModel(modelName).generateContent(request);
    } catch (error) {
      if (!isTransientServerError(error)) throw error;
      await this.sleep(TRANSIENT_RETRY_BACKOFF_MS);
      return await this.getModel(modelName).generateContent(request);
    }
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
        const result = await this.generateWithTransientRetry(modelName, {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        });
        const outputText = result.response.text() || "{}";
        const parsed = parseExtractionOutput(outputText);
        const refined = refineExtractionWithRawText(parsed, text);
        this.captureUsage(modelName, result);
        GeminiExtractorService.rememberWorkingModel(modelName, errors);
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

  /**
   * Visión (Gemini multimodal): lee el membrete/imagen de la factura y devuelve el
   * EMISOR (proveedor) y el RECEPTOR (consorcio) con sus CUITs. Se usa como fallback
   * SOLO cuando el matching por CUIT no resolvió (Cerebras es texto puro, no ve
   * imágenes). En boletas 100% imagen también recupera el consorcio; si el consorcio
   * ya se conoce (`knownConsortiumName`) se pasa como contexto para no confundirlo con
   * el emisor. Barre modelos; si todos fallan devuelve null sin lanzar.
   *
   * Registra el consumo en `lastUsage` (2026-08-24): era el único camino que
   * gastaba tokens sin dejar rastro en `TokenUsage`, así que el consumo real de
   * la cuenta quedaba subestimado.
   */
  async extractPartiesFromImage(
    pngBuffer: Buffer,
    knownConsortiumName?: string
  ): Promise<{
    providerName: string | null;
    providerTaxId: string | null;
    consortiumName: string | null;
    consortiumTaxId: string | null;
  }> {
    const base64Image = pngBuffer.toString("base64");
    const consortiumHint = knownConsortiumName?.trim()
      ? `El consorcio receptor ya fue identificado como "${knownConsortiumName.trim()}" — NO lo confundas con el emisor.`
      : "El consorcio receptor todavía no se conoce: identificalo también.";
    const prompt = [
      "Sos un asistente especializado en facturas argentinas.",
      "En la imagen hay una factura (o su membrete). Identificá a las dos partes:",
      "- EMISOR (proveedor): quien factura. Razón social + CUIT, normalmente en el",
      "  bloque superior izquierdo o superior derecho.",
      "- RECEPTOR (consorcio): a quién se factura. Razón social + CUIT.",
      consortiumHint,
      "",
      "Respondé SOLO con un JSON sin texto adicional:",
      '{ "providerName": "RAZÓN SOCIAL DEL EMISOR o null", "providerTaxId": "XX-XXXXXXXX-X o null",',
      '  "consortiumName": "RAZÓN SOCIAL DEL RECEPTOR o null", "consortiumTaxId": "XX-XXXXXXXX-X o null" }',
      "",
      "IMPORTANTE:",
      "- providerTaxId es el CUIT del EMISOR; consortiumTaxId es el del RECEPTOR. No los mezcles.",
      "- Copiá los CUITs dígito por dígito, exactamente como aparecen. No los inventes ni completes.",
      "- Si no podés leer un dato con certeza, devolvé null en ese campo.",
    ].join("\n");

    const contents = [{
      role: "user" as const,
      parts: [
        { inlineData: { mimeType: "image/png" as const, data: base64Image } },
        { text: prompt },
      ],
    }];

    const errors: string[] = [];

    for (const modelName of this.buildModelCandidates()) {
      try {
        const result = await this.generateWithTransientRetry(modelName, {
          contents,
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        });
        const outputText = result.response.text() || "{}";
        const clean = outputText.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(clean) as {
          providerName?: string | null; providerTaxId?: string | null;
          consortiumName?: string | null; consortiumTaxId?: string | null;
        };
        this.captureUsage(modelName, result);
        GeminiExtractorService.rememberWorkingModel(modelName, errors);
        return {
          providerName: parsed.providerName ?? null,
          providerTaxId: parsed.providerTaxId ?? null,
          consortiumName: parsed.consortiumName ?? null,
          consortiumTaxId: parsed.consortiumTaxId ?? null,
        };
      } catch (error) {
        errors.push(`${modelName}: ${normalizeError(error)}`);
      }
    }
    return { providerName: null, providerTaxId: null, consortiumName: null, consortiumTaxId: null };
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
        const result = await this.generateWithTransientRetry(modelName, {
          contents,
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        });
        const outputText = result.response.text() || "{}";
        const parsed = parseExtractionOutput(outputText);
        const refined = refineExtractionWithRawText(parsed, "");
        this.captureUsage(modelName, result);
        GeminiExtractorService.rememberWorkingModel(modelName, errors);
        return refined;
      } catch (error) {
        errors.push(`${modelName}: ${normalizeError(error)}`);
      }
    }

    this.throwSweepFailure("Gemini Vision image extraction", errors);
  }
}
