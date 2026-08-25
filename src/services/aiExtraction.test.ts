import { describe, it, expect } from "vitest";
import { AiExtractionChain, createAiExtractionChain, type AiExtractor } from "@/services/aiExtraction";
import { RateLimitError } from "@/lib/aiErrors";
import { AiProvider, AiUsageMetrics } from "@/types/aiUsage.types";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";

function emptyExtraction(overrides: Partial<ExtractedDocumentData> = {}): ExtractedDocumentData {
  return {
    boletaNumber: null,
    provider: null,
    consortium: null,
    providerTaxId: null,
    detail: null,
    observation: null,
    dueDate: null,
    amount: null,
    alias: null,
    clientNumber: null,
    paymentMethod: null,
    allTaxIds: [],
    ...overrides,
  };
}

/** Fake real (no mock de framework) que implementa el contrato AiExtractor. */
class FakeExtractor implements AiExtractor {
  constructor(
    public readonly provider: AiProvider,
    private readonly behavior: "ok" | "fail",
    private readonly data: ExtractedDocumentData = emptyExtraction(),
    private readonly usage: AiUsageMetrics | null = null
  ) {}

  async extractStructuredData(): Promise<ExtractedDocumentData> {
    if (this.behavior === "fail") throw new Error(`${this.provider} boom`);
    return this.data;
  }

  getLastUsage(): AiUsageMetrics | null {
    return this.usage;
  }
}

describe("AiExtractionChain.run", () => {
  it("devuelve el resultado del primer extractor que tiene éxito", async () => {
    const data = emptyExtraction({ provider: "EDESUR" });
    const usage: AiUsageMetrics = {
      provider: "gemini", model: "g", inputTokens: 1, outputTokens: 2, totalTokens: 3,
    };
    const chain = new AiExtractionChain([new FakeExtractor("gemini", "ok", data, usage)]);

    const result = await chain.run("texto");

    expect(result).not.toBeNull();
    expect(result!.provider).toBe("gemini");
    expect(result!.data).toBe(data);
    expect(result!.usage).toBe(usage);
  });

  it("cae al siguiente extractor cuando el primero falla", async () => {
    const okData = emptyExtraction({ provider: "AYSA" });
    const chain = new AiExtractionChain([
      new FakeExtractor("gemini", "fail"),
      new FakeExtractor("openai", "ok", okData),
    ]);

    const result = await chain.run("texto");

    expect(result!.provider).toBe("openai");
    expect(result!.data).toBe(okData);
  });

  it("devuelve null cuando todos los extractores fallan", async () => {
    const chain = new AiExtractionChain([
      new FakeExtractor("gemini", "fail"),
      new FakeExtractor("openai", "fail"),
      new FakeExtractor("anthropic", "fail"),
    ]);

    expect(await chain.run("texto")).toBeNull();
  });

  it("se detiene en el primer éxito y no invoca a los siguientes", async () => {
    const attempts: Array<{ provider: AiProvider; ok: boolean }> = [];
    const chain = new AiExtractionChain([
      new FakeExtractor("gemini", "ok"),
      new FakeExtractor("openai", "ok"),
    ]);

    await chain.run("texto", (provider, ok) => attempts.push({ provider, ok }));

    expect(attempts).toEqual([{ provider: "gemini", ok: true }]);
  });

  it("notifica cada intento fallido con su mensaje de error antes del éxito", async () => {
    const attempts: Array<{ provider: AiProvider; ok: boolean; error?: string }> = [];
    const chain = new AiExtractionChain([
      new FakeExtractor("gemini", "fail"),
      new FakeExtractor("openai", "ok"),
    ]);

    await chain.run("texto", (provider, ok, error) => attempts.push({ provider, ok, error }));

    expect(attempts).toEqual([
      { provider: "gemini", ok: false, error: "gemini boom" },
      { provider: "openai", ok: true, error: undefined },
    ]);
  });

  it("devuelve null sin invocar callback cuando no hay extractores", async () => {
    const chain = new AiExtractionChain([]);
    let called = false;
    const result = await chain.run("texto", () => { called = true; });
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  it("reporta rateLimited=true en el callback cuando el extractor tira RateLimitError", async () => {
    // El flag se computa sobre el OBJETO del error (instanceof), no sobre el
    // texto del mensaje — inmune a cambios de redacción/idioma del mensaje.
    class RateLimitedExtractor extends FakeExtractor {
      async extractStructuredData(): Promise<ExtractedDocumentData> {
        throw new RateLimitError("sin cuota (mensaje en cualquier idioma)");
      }
    }
    const flags: Array<{ provider: AiProvider; rateLimited: boolean | undefined }> = [];
    const chain = new AiExtractionChain([
      new RateLimitedExtractor("gemini", "fail"),
      new FakeExtractor("openai", "fail"), // Error normal
    ]);

    await chain.run("texto", (provider, ok, _msg, rateLimited) => {
      flags.push({ provider, rateLimited });
    });

    expect(flags).toEqual([
      { provider: "gemini", rateLimited: true },
      { provider: "openai", rateLimited: false },
    ]);
  });
});

describe("AiExtractionChain metadata", () => {
  it("reporta providerCount y hasProviders", () => {
    expect(new AiExtractionChain([]).hasProviders()).toBe(false);
    expect(new AiExtractionChain([]).providerCount).toBe(0);

    const chain = new AiExtractionChain([
      new FakeExtractor("gemini", "ok"),
      new FakeExtractor("openai", "ok"),
    ]);
    expect(chain.hasProviders()).toBe(true);
    expect(chain.providerCount).toBe(2);
  });
});

describe("createAiExtractionChain — orden capacidad-primero", () => {
  it("ordena Cerebras → Gemini → OpenAI → Claude cuando todos tienen key", async () => {
    const chain = await createAiExtractionChain({
      cerebras: { apiKey: "x", model: "llama-3.3-70b" },
      gemini: { apiKey: "x" },
      openai: { apiKey: "x" },
      anthropic: { apiKey: "x" },
    });
    expect(chain.providerOrder).toEqual(["cerebras", "gemini", "openai", "anthropic"]);
  });

  it("incluye solo los proveedores con apiKey presente", async () => {
    const chain = await createAiExtractionChain({
      cerebras: { apiKey: "x" },
      gemini: { apiKey: "" },
    });
    expect(chain.providerOrder).toEqual(["cerebras"]);
  });
});
