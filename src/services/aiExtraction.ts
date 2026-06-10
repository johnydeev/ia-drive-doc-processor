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
 */
export type AiAttemptCallback = (
  provider: AiProvider,
  ok: boolean,
  error?: string
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
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    }
    return null;
  }
}

/**
 * Construye la cadena importando dinámicamente solo los servicios cuyos
 * proveedores tienen API key configurada (mantiene la carga perezosa de SDKs
 * que ya tenía el pipeline). Orden de fallback: Gemini → OpenAI → Claude.
 */
export async function createAiExtractionChain(
  config: AiExtractionChainConfig
): Promise<AiExtractionChain> {
  const extractors: AiExtractor[] = [];

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
