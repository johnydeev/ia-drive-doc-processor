import { describe, it, expect } from "vitest";
import {
  OpenAICompatibleExtractorService,
  type ChatCompleteFn,
} from "@/services/openAICompatibleExtractor.service";

function fakeComplete(
  content: string,
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
): { fn: ChatCompleteFn; calls: unknown[] } {
  const calls: unknown[] = [];
  const fn: ChatCompleteFn = async (params) => {
    calls.push(params);
    return { choices: [{ message: { content } }], usage };
  };
  return { fn, calls };
}

describe("OpenAICompatibleExtractorService", () => {
  it("expone el provider configurado", () => {
    const { fn } = fakeComplete("{}");
    const svc = new OpenAICompatibleExtractorService({
      provider: "cerebras", apiKey: "x", baseURL: "https://api.cerebras.ai/v1", model: "llama-3.3-70b", complete: fn,
    });
    expect(svc.provider).toBe("cerebras");
  });

  it("parsea el JSON de la respuesta y mapea el usage al provider correcto", async () => {
    const content = JSON.stringify({ provider: "ACME S.A.", consortium: "TEST 123", amount: 1000 });
    const { fn, calls } = fakeComplete(content, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
    const svc = new OpenAICompatibleExtractorService({
      provider: "cerebras", apiKey: "x", baseURL: "https://api.cerebras.ai/v1", model: "gpt-oss-120b", complete: fn,
    });

    const data = await svc.extractStructuredData("texto de prueba sin marcadores");

    expect(data.provider).toBe("ACME S.A.");
    expect(data.consortium).toBe("TEST 123");
    expect(data.amount).toBe(1000);

    const usage = svc.getLastUsage();
    expect(usage).toEqual({ provider: "cerebras", model: "gpt-oss-120b", inputTokens: 100, outputTokens: 20, totalTokens: 120 });

    // Se pidió JSON mode y el modelo correcto.
    expect(calls[0]).toMatchObject({
      model: "gpt-oss-120b",
      temperature: 0,
      response_format: { type: "json_object" },
    });
  });

  it("usa {} cuando el modelo no devuelve content (sin romper)", async () => {
    const { fn } = fakeComplete("");
    const svc = new OpenAICompatibleExtractorService({
      provider: "cerebras", apiKey: "x", baseURL: "https://api.cerebras.ai/v1", model: "llama-3.3-70b", complete: fn,
    });
    const data = await svc.extractStructuredData("hola");
    expect(data.provider).toBeNull();
    expect(data.amount).toBeNull();
  });

  it("lanza si el texto de entrada está vacío", async () => {
    const { fn } = fakeComplete("{}");
    const svc = new OpenAICompatibleExtractorService({
      provider: "cerebras", apiKey: "x", baseURL: "https://api.cerebras.ai/v1", model: "m", complete: fn,
    });
    await expect(svc.extractStructuredData("   ")).rejects.toThrow(/No text/);
  });
});
