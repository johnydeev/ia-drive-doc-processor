import OpenAI from "openai";
import {
  buildExtractionPrompt,
  parseExtractionOutput,
  refineExtractionWithRawText,
} from "@/lib/extraction";
import { AiUsageMetrics, AiProvider } from "@/types/aiUsage.types";
import { AiExtractor } from "@/services/aiExtraction";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";

/**
 * Extractor genérico para proveedores con API compatible con la Chat Completions
 * de OpenAI (Cerebras, Groq, y a futuro Mistral/OpenRouter/DeepInfra). Reutiliza
 * el SDK `openai` cambiando `baseURL`, y el mismo prompt/parseo/refinamiento que
 * los demás extractores, de modo que la cadena los trata de forma intercambiable.
 *
 * El llamado al modelo se inyecta como `complete` (seam testeable, igual que los
 * seams del pipeline): en prod usa el SDK real; en tests se pasa un fake.
 */
export interface ChatCompletionParams {
  model: string;
  temperature: number;
  response_format: { type: "json_object" };
  messages: { role: "user"; content: string }[];
}

export interface ChatCompletionResponse {
  choices: { message: { content: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export type ChatCompleteFn = (params: ChatCompletionParams) => Promise<ChatCompletionResponse>;

export interface OpenAICompatibleOptions {
  provider: AiProvider;
  apiKey: string;
  baseURL: string;
  model: string;
  /** Seam para tests; en prod se usa el SDK de OpenAI contra `baseURL`. */
  complete?: ChatCompleteFn;
}

export class OpenAICompatibleExtractorService implements AiExtractor {
  readonly provider: AiProvider;
  private readonly model: string;
  private readonly complete: ChatCompleteFn;
  private lastUsage: AiUsageMetrics | null = null;

  constructor(options: OpenAICompatibleOptions) {
    if (!options.apiKey?.trim()) {
      throw new Error(`API key is required for ${options.provider} extractor`);
    }
    this.provider = options.provider;
    this.model = options.model;

    if (options.complete) {
      this.complete = options.complete;
    } else {
      const client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL });
      this.complete = (params) =>
        client.chat.completions.create(params) as unknown as Promise<ChatCompletionResponse>;
    }
  }

  async extractStructuredData(text: string): Promise<ExtractedDocumentData> {
    if (!text.trim()) {
      throw new Error(`No text provided for ${this.provider} extraction`);
    }
    this.lastUsage = null;
    const prompt = buildExtractionPrompt(text);

    const response = await this.complete({
      model: this.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    });

    const outputText = response.choices[0]?.message?.content || "{}";
    const parsed = parseExtractionOutput(outputText);

    const usage = response.usage;
    const inputTokens = Number(usage?.prompt_tokens ?? 0);
    const outputTokens = Number(usage?.completion_tokens ?? 0);
    const totalTokens = Number(usage?.total_tokens ?? inputTokens + outputTokens);
    this.lastUsage = {
      provider: this.provider,
      model: this.model,
      inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
      outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
      totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    };

    return refineExtractionWithRawText(parsed, text);
  }

  getLastUsage(): AiUsageMetrics | null {
    return this.lastUsage;
  }
}
