import { describe, it, expect, beforeEach } from "vitest";
import type { GenerativeModel } from "@google/generative-ai";
import { GeminiExtractorService } from "@/services/geminiExtractor.service";
import { RateLimitError } from "@/lib/aiErrors";

/** Respuesta exitosa con la forma que devuelve el SDK. */
function okResponse(overrides: Record<string, unknown> = {}) {
  const payload = {
    boletaNumber: "0001-00000001",
    provider: "PROVEEDOR SA",
    consortium: "CALLE FALSA 123",
    providerTaxId: "30-71497816-7",
    amount: 1000,
    dueDate: "2026-09-10",
    ...overrides,
  };
  return {
    response: {
      text: () => JSON.stringify(payload),
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 },
    },
  };
}

function httpError(status: number, message: string): Error {
  return new Error(`[GoogleGenerativeAI Error]: [${status} ${message}]`);
}

type Outcome = Error | ReturnType<typeof okResponse>;

/**
 * Fake del servicio: sustituye `getModel` por uno que consume una cola de
 * desenlaces por modelo. Cuando la cola llega a su último elemento, lo repite.
 * Un modelo sin cola definida devuelve 404, como los dados de baja.
 */
class FakeGemini extends GeminiExtractorService {
  public readonly calls: string[] = [];
  public readonly slept: number[];
  private readonly queues: Map<string, Outcome[]>;

  constructor(behavior: Record<string, Outcome[]>) {
    const slept: number[] = [];
    super({
      apiKey: "test-key",
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    });
    this.slept = slept;
    this.queues = new Map(Object.entries(behavior).map(([k, v]) => [k, [...v]]));
  }

  protected getModel(modelName: string): GenerativeModel {
    return {
      generateContent: async () => {
        this.calls.push(modelName);
        const queue = this.queues.get(modelName);
        if (!queue || queue.length === 0) throw httpError(404, "Not Found");
        const outcome = queue.length === 1 ? queue[0] : queue.shift()!;
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    } as unknown as GenerativeModel;
  }
}

const TEXTO = "CUIT 30-71497816-7 TOTAL 1000";

beforeEach(() => {
  GeminiExtractorService.resetWorkingModel();
});

describe("GeminiExtractorService — candidatos de modelo", () => {
  it("arranca por gemini-2.5-flash-lite y no llama a otro si responde", async () => {
    const fake = new FakeGemini({ "gemini-2.5-flash-lite": [okResponse()] });
    await fake.extractStructuredData(TEXTO);
    expect(fake.calls).toEqual(["gemini-2.5-flash-lite"]);
  });

  it("no incluye los modelos 2.0, dados de baja por Google", async () => {
    const fake = new FakeGemini({});
    await expect(fake.extractStructuredData("texto")).rejects.toThrow();
    expect(fake.calls).not.toContain("gemini-2.0-flash");
    expect(fake.calls).not.toContain("gemini-2.0-flash-lite");
  });

  it("barre exactamente los 3 modelos vivos", async () => {
    const fake = new FakeGemini({});
    await expect(fake.extractStructuredData("texto")).rejects.toThrow();
    expect(fake.calls).toEqual([
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash",
      "gemini-flash-latest",
    ]);
  });
});

describe("GeminiExtractorService — reintento ante 503", () => {
  it("reintenta el MISMO modelo una vez antes de saltar", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(503, "Service Unavailable"), okResponse()],
    });
    await fake.extractStructuredData(TEXTO);
    expect(fake.calls).toEqual(["gemini-2.5-flash-lite", "gemini-2.5-flash-lite"]);
  });

  it("espera 2000 ms entre el intento y el reintento", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(503, "Service Unavailable"), okResponse()],
    });
    await fake.extractStructuredData(TEXTO);
    expect(fake.slept).toEqual([2000]);
  });

  it("reintenta una sola vez: si el 503 se repite, salta al siguiente modelo", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(503, "Service Unavailable")],
      "gemini-2.5-flash": [okResponse()],
    });
    await fake.extractStructuredData(TEXTO);
    expect(fake.calls).toEqual([
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash",
    ]);
  });

  it("NO reintenta ante 429: la cuota no vuelve en 2 segundos", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(429, "Too Many Requests")],
      "gemini-2.5-flash": [okResponse()],
    });
    await fake.extractStructuredData(TEXTO);
    expect(fake.calls).toEqual(["gemini-2.5-flash-lite", "gemini-2.5-flash"]);
    expect(fake.slept).toEqual([]);
  });

  it("NO reintenta ante 404: el modelo no existe más", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(404, "Not Found")],
      "gemini-2.5-flash": [okResponse()],
    });
    await fake.extractStructuredData(TEXTO);
    expect(fake.calls).toEqual(["gemini-2.5-flash-lite", "gemini-2.5-flash"]);
  });
});

describe("GeminiExtractorService — desenlace del barrido completo", () => {
  it("lanza RateLimitError si TODOS los modelos dieron 503", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(503, "Service Unavailable")],
      "gemini-2.5-flash": [httpError(503, "Service Unavailable")],
      "gemini-flash-latest": [httpError(503, "Service Unavailable")],
    });
    await expect(fake.extractStructuredData("texto")).rejects.toBeInstanceOf(RateLimitError);
  });

  it("lanza RateLimitError si TODOS los modelos dieron 429", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(429, "Too Many Requests")],
      "gemini-2.5-flash": [httpError(429, "Too Many Requests")],
      "gemini-flash-latest": [httpError(429, "Too Many Requests")],
    });
    await expect(fake.extractStructuredData("texto")).rejects.toBeInstanceOf(RateLimitError);
  });

  it("lanza RateLimitError con 429 y 503 mezclados: los dos son transitorios", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(429, "Too Many Requests")],
      "gemini-2.5-flash": [httpError(503, "Service Unavailable")],
      "gemini-flash-latest": [httpError(429, "Too Many Requests")],
    });
    await expect(fake.extractStructuredData("texto")).rejects.toBeInstanceOf(RateLimitError);
  });

  it("lanza Error normal si alguno falló por algo NO transitorio", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(503, "Service Unavailable")],
      "gemini-2.5-flash": [httpError(400, "Bad Request")],
      "gemini-flash-latest": [httpError(503, "Service Unavailable")],
    });
    // Se captura una sola vez: encadenar dos `expect().rejects` sobre la misma
    // promesa deja una rechazada sin manejar en el segundo await.
    const error = await fake.extractStructuredData("texto").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RateLimitError);
  });
});

describe("GeminiExtractorService — modelo pegajoso", () => {
  it("fija el modelo cuando resuelve el primero, sin errores previos", async () => {
    const fake = new FakeGemini({ "gemini-2.5-flash-lite": [okResponse()] });
    await fake.extractStructuredData(TEXTO);
    expect(GeminiExtractorService.workingModel).toBe("gemini-2.5-flash-lite");
  });

  it("NO fija el modelo caro cuando el salto fue por 503", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(503, "Service Unavailable")],
      "gemini-2.5-flash": [okResponse()],
    });
    await fake.extractStructuredData(TEXTO);
    expect(GeminiExtractorService.workingModel).toBeNull();
  });

  it("SÍ fija el modelo cuando el salto fue por cuota (429)", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(429, "Too Many Requests")],
      "gemini-2.5-flash": [okResponse()],
    });
    await fake.extractStructuredData(TEXTO);
    expect(GeminiExtractorService.workingModel).toBe("gemini-2.5-flash");
  });

  it("tras un 503 la boleta siguiente vuelve a arrancar por flash-lite", async () => {
    const primera = new FakeGemini({
      "gemini-2.5-flash-lite": [httpError(503, "Service Unavailable")],
      "gemini-2.5-flash": [okResponse()],
    });
    await primera.extractStructuredData(TEXTO);

    const segunda = new FakeGemini({ "gemini-2.5-flash-lite": [okResponse()] });
    await segunda.extractStructuredData(TEXTO);
    expect(segunda.calls[0]).toBe("gemini-2.5-flash-lite");
  });
});

describe("GeminiExtractorService — tokens del fallback visual", () => {
  const png = Buffer.from("fake-png-bytes");

  it("registra el consumo de extractPartiesFromImage", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [
        okResponse({ providerName: "PROVEEDOR SA", providerTaxId: "30-71497816-7" }),
      ],
    });
    await fake.extractPartiesFromImage(png);
    const usage = fake.getLastUsage();
    expect(usage).not.toBeNull();
    expect(usage!.provider).toBe("gemini");
    expect(usage!.model).toBe("gemini-2.5-flash-lite");
    expect(usage!.totalTokens).toBe(120);
  });

  it("devuelve el CUIT del emisor leído de la imagen", async () => {
    const fake = new FakeGemini({
      "gemini-2.5-flash-lite": [
        okResponse({ providerName: "PROVEEDOR SA", providerTaxId: "30-71497816-7" }),
      ],
    });
    const parties = await fake.extractPartiesFromImage(png);
    expect(parties.providerTaxId).toBe("30-71497816-7");
  });

  it("devuelve nulls sin lanzar cuando todos los modelos fallan", async () => {
    const fake = new FakeGemini({});
    const parties = await fake.extractPartiesFromImage(png);
    expect(parties).toEqual({
      providerName: null,
      providerTaxId: null,
      consortiumName: null,
      consortiumTaxId: null,
    });
  });
});
