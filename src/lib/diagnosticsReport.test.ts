import { describe, it, expect } from "vitest";
import {
  buildDiagnosticsJson,
  buildDiagnosticsMarkdown,
  diagnosticsFileName,
  formatRunStamp,
  summarizeResults,
  type BoletaDiagnostics,
  type DiagnosticsRun,
} from "@/lib/diagnosticsReport";

function boleta(over: Partial<BoletaDiagnostics> = {}): BoletaDiagnostics {
  return {
    fileId: "file-1",
    fileName: "Fact. 51837.pdf",
    result: "ok",
    reason: null,
    reasonText: null,
    textSource: "direct",
    textChars: 541,
    emitterBlock: true,
    lsp: null,
    ai: { provider: "cerebras", model: "gpt-oss-120b", total: 4285 },
    match: { consortium: "cuit", provider: "cuit" },
    ms: { total: 8500 },
    extracted: { consortium: "CONSORCIO ARAOZ 192", provider: "BPACE", amount: 104500 },
    canonical: { consortium: "ARAOZ 192", provider: "BPACE E HIJOS S.R.L.", amount: 104500 },
    promptText: "FACTURA Nro. 0010-00051837 ...",
    ...over,
  };
}

const run: DiagnosticsRun = {
  runId: "run-abc",
  clientName: "MorinigoAdm",
  // 18/08/2026 15:30 en Buenos Aires (UTC-3) = 18:30 UTC.
  startedAt: new Date("2026-08-18T18:30:00Z"),
  finishedAt: new Date("2026-08-18T18:31:25Z"),
};

describe("formatRunStamp", () => {
  it("usa la hora de Buenos Aires, no la de la máquina", () => {
    expect(formatRunStamp(new Date("2026-08-18T18:30:00Z"))).toBe("2026-08-18_15-30");
  });

  it("cruza bien el cambio de día", () => {
    // 02:00 UTC = 23:00 del día anterior en Buenos Aires.
    expect(formatRunStamp(new Date("2026-08-18T02:00:00Z"))).toBe("2026-08-17_23-00");
  });
});

describe("diagnosticsFileName", () => {
  it("arma el nombre base de los dos archivos", () => {
    expect(diagnosticsFileName(run.startedAt, "run-abc")).toBe("diagnostico-2026-08-18_15-30-un-abc");
  });

  it("dos corridas del mismo minuto no colisionan", () => {
    const a = diagnosticsFileName(run.startedAt, "cmabc123456");
    const b = diagnosticsFileName(run.startedAt, "cmxyz987654");

    expect(a).not.toBe(b);
  });
});

describe("summarizeResults", () => {
  it("cuenta las boletas por camino de salida", () => {
    const items = [boleta(), boleta({ result: "unassigned" }), boleta({ result: "unassigned" })];

    expect(summarizeResults(items)).toEqual({ ok: 1, unassigned: 2 });
  });

  it("devuelve vacío sin boletas", () => {
    expect(summarizeResults([])).toEqual({});
  });
});

describe("buildDiagnosticsJson", () => {
  it("incluye el texto que vio la IA (es lo que permite diagnosticar el prompt)", () => {
    const parsed = JSON.parse(buildDiagnosticsJson(run, [boleta()]));

    expect(parsed.boletas[0].promptText).toBe("FACTURA Nro. 0010-00051837 ...");
    expect(parsed.boletas[0].extracted).toEqual({
      consortium: "CONSORCIO ARAOZ 192", provider: "BPACE", amount: 104500,
    });
  });

  it("resume totales por resultado", () => {
    const parsed = JSON.parse(buildDiagnosticsJson(run, [boleta(), boleta({ result: "no_amount" })]));

    expect(parsed.totals).toEqual({ boletas: 2, results: { ok: 1, no_amount: 1 } });
    expect(parsed.runId).toBe("run-abc");
  });
});

describe("buildDiagnosticsMarkdown", () => {
  it("encabeza con cliente, duración y conteo por resultado", () => {
    const md = buildDiagnosticsMarkdown(run, [boleta(), boleta({ result: "unassigned" })]);

    expect(md).toContain("**Cliente:** MorinigoAdm");
    expect(md).toContain("**Duración:** 85s");
    expect(md).toContain("**Boletas:** 2");
    expect(md).toContain("ok=1");
    expect(md).toContain("unassigned=1");
  });

  it("compara lo extraído contra lo canonizado por boleta", () => {
    const md = buildDiagnosticsMarkdown(run, [boleta()]);

    expect(md).toContain("### Fact. 51837.pdf");
    expect(md).toContain("| consortium | CONSORCIO ARAOZ 192 | ARAOZ 192 |");
    expect(md).toContain("| provider | BPACE | BPACE E HIJOS S.R.L. |");
  });

  it("muestra el motivo cuando la boleta no entró", () => {
    const md = buildDiagnosticsMarkdown(run, [
      boleta({
        result: "unassigned",
        reason: "provider_not_found",
        reasonText: "No se pudo identificar el proveedor",
        canonical: null,
      }),
    ]);

    expect(md).toContain("`unassigned` (provider_not_found)");
    expect(md).toContain("**Detalle:** No se pudo identificar el proveedor");
    // Sin canonizar, la columna queda vacía en vez de romper.
    expect(md).toContain("| provider | BPACE | — |");
  });

  it("no rompe con una corrida sin boletas", () => {
    const md = buildDiagnosticsMarkdown(run, []);

    expect(md).toContain("**Boletas:** 0");
    expect(md).toContain("**Resultados:** —");
  });
});
