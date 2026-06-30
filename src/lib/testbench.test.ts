import { describe, it, expect } from "vitest";
import { runLogicalPipeline, compareToExpected, type TestbenchDirectory } from "@/lib/testbench";
import type { AiExtractor } from "@/services/aiExtraction";
import type { ExtractedDocumentData } from "@/types/extractedDocument.types";
import type { AiUsageMetrics } from "@/types/aiUsage.types";

function extracted(overrides: Partial<ExtractedDocumentData> = {}): ExtractedDocumentData {
  return {
    boletaNumber: null, provider: null, consortium: null, providerTaxId: null,
    detail: null, observation: null, dueDate: null, amount: null, alias: null,
    clientNumber: null, paymentMethod: null, allTaxIds: [], isBoleta: true, ...overrides,
  };
}

class FakeExtractor implements AiExtractor {
  readonly provider = "cerebras" as const;
  constructor(private readonly data: ExtractedDocumentData) {}
  async extractStructuredData(): Promise<ExtractedDocumentData> { return this.data; }
  getLastUsage(): AiUsageMetrics | null {
    return { provider: "cerebras", model: "gpt-oss-120b", inputTokens: 100, outputTokens: 20, totalTokens: 120 };
  }
}

// Directorio de prueba: 1 consorcio + 1 proveedor con CUITs conocidos.
const directory: TestbenchDirectory = {
  consortiums: [{ id: "c1", canonicalName: "TEST 100", rawName: "TEST 100", cuit: "30-11111111-2", matchNames: null }],
  providers: [{ id: "p1", canonicalName: "PROV SA", cuit: "30-22222222-0", matchNames: null, paymentAlias: null }],
};

// Texto neutro (sin marcadores no-boleta y sin CUITs con checksum válido) → no dispara la heurística
// ni aporta CUITs del texto; los CUITs los controla el fake vía allTaxIds.
const NEUTRAL_TEXT = "factura de servicios de prueba para el consorcio";

describe("runLogicalPipeline", () => {
  it("result=ok cuando matchea consorcio y proveedor por CUIT", async () => {
    const data = extracted({
      consortium: "TEST 100", provider: "PROV SA", amount: 109400,
      allTaxIds: ["30111111112", "30222222220"],
    });
    const r = await runLogicalPipeline({ text: NEUTRAL_TEXT, extractor: new FakeExtractor(data), directory });
    expect(r.result).toBe("ok");
    expect(r.match.consortium).toBe("TEST 100");
    expect(r.match.provider).toBe("PROV SA");
    expect(r.canonical.amount).toBe(109400);
    expect(r.usage?.model).toBe("gpt-oss-120b");
  });

  it("result=no_amount cuando la IA no trae monto", async () => {
    const data = extracted({ consortium: "TEST 100", amount: null });
    const r = await runLogicalPipeline({ text: NEUTRAL_TEXT, extractor: new FakeExtractor(data), directory });
    expect(r.result).toBe("no_amount");
  });

  it("result=no_boleta cuando la IA marca isBoleta=false", async () => {
    const data = extracted({ amount: 1000, isBoleta: false });
    const r = await runLogicalPipeline({ text: NEUTRAL_TEXT, extractor: new FakeExtractor(data), directory });
    expect(r.result).toBe("no_boleta");
    expect(r.reason).toBe("ai");
  });

  it("result=unassigned cuando el proveedor no está en el directorio", async () => {
    const data = extracted({
      consortium: "TEST 100", provider: "DESCONOCIDO SA", amount: 5000,
      allTaxIds: ["30111111112", "30999999990"], // 2º CUIT no está cargado
    });
    const r = await runLogicalPipeline({ text: NEUTRAL_TEXT, extractor: new FakeExtractor(data), directory });
    expect(r.result).toBe("unassigned");
    expect(r.reason).toBe("provider_not_found");
    expect(r.match.consortium).toBe("TEST 100"); // el consorcio sí matcheó
  });
});

describe("compareToExpected", () => {
  const okResult = {
    result: "ok" as const, reason: null, lspProvider: null,
    extracted: null, usage: null, errors: [],
    match: { consortium: "TEST 100", consortiumMethod: "CUIT", provider: "PROV SA", providerMethod: "CUIT" },
    canonical: {
      consortium: "TEST 100", provider: "PROV SA", providerTaxId: "30-22222222-0",
      amount: 109400, dueDate: "2026-06-19", boletaNumber: "00002-00003876",
    },
  };

  it("marca todos los campos como ok cuando coinciden (monto por valor, CUIT por dígitos)", () => {
    const cmp = compareToExpected(okResult, {
      consortium: "TEST 100", provider: "PROV SA", providerTaxId: "30222222220",
      amount: 109400, result: "ok",
    });
    expect(cmp.fields.amount).toBe("ok");
    expect(cmp.fields.providerTaxId).toBe("ok"); // compara por dígitos
    expect(cmp.fields.consortium).toBe("ok");
    expect(cmp.fields.result).toBe("ok");
    expect(cmp.hits).toBe(cmp.total);
  });

  it("marca mismatch cuando un campo difiere y absent cuando el esperado no lo trae", () => {
    const cmp = compareToExpected(okResult, { amount: 999999, dueDate: undefined });
    expect(cmp.fields.amount).toBe("mismatch");
    expect(cmp.fields.dueDate).toBe("absent"); // no estaba en el esperado → no se compara
    expect(cmp.hits).toBe(0);
    expect(cmp.total).toBe(1); // solo amount estaba presente en el esperado
  });
});
