import { isRateLimitError } from "@/lib/aiErrors";
import { AiProvider, AiUsageMetrics } from "@/types/aiUsage.types";
import type { AiRequestCounter } from "@/lib/aiRequestCounter";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";

/**
 * Contrato común de un extractor de datos estructurados por IA.
 *
 * Todos los servicios (Cerebras / Gemini / OpenAI / Claude) exponen esta
 * misma forma; declararla explícitamente permite tratarlos de forma
 * intercambiable (Strategy) y encadenarlos como fallback (Chain of
 * Responsibility) sin duplicar la lógica de reintento en cada caller.
 */
export interface AiExtractor {
  readonly provider: AiProvider;
  /**
   * `counter` es opcional y lo incrementa **el extractor**, no la cadena: un
   * barrido de 3 modelos de Gemini son 3 requests dentro de un solo intento.
   */
  extractStructuredData(text: string, counter?: AiRequestCounter): Promise<ExtractedDocumentData>;
  getLastUsage(): AiUsageMetrics | null;
}

/** Credenciales/modelo de un proveedor de IA. */
export interface AiProviderCredentials {
  apiKey?: string;
  model?: string;
}

/**
 * Configuración para construir la cadena. El orden de fallback lo define
 * `PROVIDER_ORDER`: Gemini → Cerebras → OpenAI → Claude. Solo se incluyen los
 * proveedores que tienen `apiKey` presente.
 */
export interface AiExtractionChainConfig {
  cerebras?: AiProviderCredentials;
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
    onAttempt?: AiAttemptCallback,
    counter?: AiRequestCounter
  ): Promise<AiExtractionResult | null> {
    for (const extractor of this.extractors) {
      try {
        const data = await extractor.extractStructuredData(text, counter);
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
 * Una entrada del orden de fallback: qué proveedor es, de dónde saca sus
 * credenciales y cómo se construye su extractor.
 *
 * El orden de este array ES el orden de fallback. Antes salía del orden físico
 * de cinco bloques `if`, así que para saber quién iba primero había que leer la
 * función entera.
 */
interface ProviderSlot {
  provider: AiProvider;
  credentials: (config: AiExtractionChainConfig) => AiProviderCredentials | undefined;
  build: (credentials: AiProviderCredentials) => Promise<AiExtractor>;
}

/**
 * Orden de fallback: **Gemini → Cerebras → OpenAI → Claude**.
 *
 * Gemini pasó a PRIMERO el 2026-08-30 (pieza 1 del spec
 * `2026-08-24-gemini-tier-pago-cadena-y-modelos-design.md`), por decisión del
 * owner: Cerebras venía devolviendo **402 (sin cuota)** en todas las boletas, o
 * sea la cadena ya dependía de Gemini de hecho, pero pagando primero un intento
 * fallido contra Cerebras en cada boleta.
 *
 * **El riesgo del free tier sigue vigente**: la cuota de Gemini es diaria POR
 * MODELO (~20 requests), así que en un día de mucho volumen las primeras boletas
 * queman el balde y el resto paga el barrido de los 3 modelos antes de caer al
 * siguiente proveedor. Con Cerebras sano y en segundo lugar eso se absorbe; sin
 * Cerebras, no hay red.
 *
 * Volver atrás es mover este bloque después del de Cerebras y dar vuelta el test
 * de `providerOrder`.
 */
const PROVIDER_ORDER: ProviderSlot[] = [
  {
    provider: "gemini",
    credentials: (c) => c.gemini,
    build: async (creds) => {
      const { GeminiExtractorService } = await import("@/services/geminiExtractor.service");
      return new GeminiExtractorService({ apiKey: creds.apiKey, model: creds.model });
    },
  },
  {
    provider: "cerebras",
    credentials: (c) => c.cerebras,
    build: async (creds) => {
      const { OpenAICompatibleExtractorService } = await import("@/services/openAICompatibleExtractor.service");
      return new OpenAICompatibleExtractorService({
        provider: "cerebras",
        apiKey: creds.apiKey!,
        baseURL: "https://api.cerebras.ai/v1",
        model: creds.model?.trim() || "gpt-oss-120b",
      });
    },
  },
  {
    provider: "openai",
    credentials: (c) => c.openai,
    build: async (creds) => {
      const { AiExtractorService } = await import("@/services/aiExtractor.service");
      return new AiExtractorService({ apiKey: creds.apiKey, model: creds.model });
    },
  },
  {
    provider: "anthropic",
    credentials: (c) => c.anthropic,
    build: async (creds) => {
      const { ClaudeExtractorService } = await import("@/services/claudeExtractor.service");
      return new ClaudeExtractorService({ apiKey: creds.apiKey, model: creds.model });
    },
  },
];

/**
 * Construye la cadena recorriendo `PROVIDER_ORDER` e importando dinámicamente
 * solo los servicios cuyos proveedores tienen API key (mantiene la carga
 * perezosa de SDKs que ya tenía el pipeline).
 */
export async function createAiExtractionChain(
  config: AiExtractionChainConfig
): Promise<AiExtractionChain> {
  const extractors: AiExtractor[] = [];

  for (const slot of PROVIDER_ORDER) {
    const creds = slot.credentials(config);
    if (!creds?.apiKey) continue;
    extractors.push(await slot.build(creds));
  }

  return new AiExtractionChain(extractors);
}
