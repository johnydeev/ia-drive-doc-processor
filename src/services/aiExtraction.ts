import { isRateLimitError } from "@/lib/aiErrors";
import { AiProvider, AiUsageMetrics } from "@/types/aiUsage.types";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";

/**
 * Contrato común de un extractor de datos estructurados por IA.
 *
 * Los tres servicios (Gemini / OpenAI / Claude) ya exponían esta misma forma
 * de manera implícita; declararla explícitamente permite tratarlos de forma
 * intercambiable (Strategy) y encadenarlos como fallback (Chain of
 * Responsibility) sin duplicar la lógica de reintento en cada caller.
 */
export interface AiExtractor {
  readonly provider: AiProvider;
  extractStructuredData(text: string): Promise<ExtractedDocumentData>;
  getLastUsage(): AiUsageMetrics | null;
}

/** Credenciales/modelo de un proveedor de IA. */
export interface AiProviderCredentials {
  apiKey?: string;
  model?: string;
}

/**
 * Configuración para construir la cadena. El orden de fallback es fijo:
 * Gemini → OpenAI → Claude. Solo se incluyen los proveedores que tienen
 * `apiKey` presente.
 */
export interface AiExtractionChainConfig {
  cerebras?: AiProviderCredentials;
  groq?: AiProviderCredentials;
  gemini?: AiProviderCredentials;
  openai?: AiProviderCredentials;
  anthropic?: AiProviderCredentials;
}

export interface AiExtractionResult {
  data: ExtractedDocumentData;
  usage: AiUsageMetrics | null;
  provider: AiProvider;
}

/**
 * Callback invocado tras cada intento. Desacopla el logging: el pipeline usa
 * `pipelineLog`, la ruta de scan usa `console.warn`, sin que la cadena tenga
 * que conocer ninguno de los dos.
 *
 * `rateLimited` se computa acá, sobre el OBJETO del error (instanceof
 * RateLimitError + heurística de texto). Los callers NO deben re-clasificar
 * parseando el mensaje: la redacción/idioma del mensaje puede cambiar (bug
 * real: "sin cuota" en español no matcheaba el patrón "quota" → boletas con
 * cuota agotada caían a OCR_ONLY en vez de volver a Pendientes).
 */
export type AiAttemptCallback = (
  provider: AiProvider,
  ok: boolean,
  error?: string,
  rateLimited?: boolean
) => void;

/**
 * Ejecuta una lista ordenada de extractores hasta que uno tenga éxito.
 * Reemplaza los bloques `try/catch` Gemini→OpenAI→Claude que estaban
 * duplicados en el pipeline y en la ruta de scan manual.
 */
export class AiExtractionChain {
  constructor(private readonly extractors: AiExtractor[]) {}

  get providerCount(): number {
    return this.extractors.length;
  }

  /** Orden de fallback de los proveedores (para tests y diagnóstico). */
  get providerOrder(): AiProvider[] {
    return this.extractors.map((e) => e.provider);
  }

  hasProviders(): boolean {
    return this.extractors.length > 0;
  }

  async run(
    text: string,
    onAttempt?: AiAttemptCallback
  ): Promise<AiExtractionResult | null> {
    for (const extractor of this.extractors) {
      try {
        const data = await extractor.extractStructuredData(text);
        onAttempt?.(extractor.provider, true);
        return { data, usage: extractor.getLastUsage(), provider: extractor.provider };
      } catch (error) {
        onAttempt?.(
          extractor.provider,
          false,
          error instanceof Error ? error.message : "Unknown error",
          isRateLimitError(error)
        );
      }
    }
    return null;
  }
}

/**
 * Construye la cadena importando dinámicamente solo los servicios cuyos
 * proveedores tienen API key configurada (mantiene la carga perezosa de SDKs
 * que ya tenía el pipeline). Orden de fallback: Cerebras → Groq → Gemini → OpenAI → Claude.
 */
export async function createAiExtractionChain(
  config: AiExtractionChainConfig
): Promise<AiExtractionChain> {
  const extractors: AiExtractor[] = [];

  if (config.cerebras?.apiKey) {
    const { OpenAICompatibleExtractorService } = await import("@/services/openAICompatibleExtractor.service");
    extractors.push(
      new OpenAICompatibleExtractorService({
        provider: "cerebras",
        apiKey: config.cerebras.apiKey,
        baseURL: "https://api.cerebras.ai/v1",
        model: config.cerebras.model?.trim() || "gpt-oss-120b",
      })
    );
  }

  if (config.groq?.apiKey) {
    const { OpenAICompatibleExtractorService } = await import("@/services/openAICompatibleExtractor.service");
    extractors.push(
      new OpenAICompatibleExtractorService({
        provider: "groq",
        apiKey: config.groq.apiKey,
        baseURL: "https://api.groq.com/openai/v1",
        model: config.groq.model?.trim() || "llama-3.3-70b-versatile",
      })
    );
  }

  if (config.gemini?.apiKey) {
    const { GeminiExtractorService } = await import("@/services/geminiExtractor.service");
    extractors.push(
      new GeminiExtractorService({ apiKey: config.gemini.apiKey, model: config.gemini.model })
    );
  }

  if (config.openai?.apiKey) {
    const { AiExtractorService } = await import("@/services/aiExtractor.service");
    extractors.push(
      new AiExtractorService({ apiKey: config.openai.apiKey, model: config.openai.model })
    );
  }

  if (config.anthropic?.apiKey) {
    const { ClaudeExtractorService } = await import("@/services/claudeExtractor.service");
    extractors.push(
      new ClaudeExtractorService({ apiKey: config.anthropic.apiKey, model: config.anthropic.model })
    );
  }

  return new AiExtractionChain(extractors);
}
