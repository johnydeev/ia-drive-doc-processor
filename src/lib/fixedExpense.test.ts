import { describe, it, expect } from "vitest";
import {
  validateFixedExpenseTarget,
  obligationMatchesInvoice,
} from "./fixedExpense";

describe("validateFixedExpenseTarget", () => {
  it("acepta exactamente un objetivo (provider)", () => {
    expect(validateFixedExpenseTarget({ providerId: "p1", lspServiceId: null })).toBeNull();
  });
  it("acepta exactamente un objetivo (lspService)", () => {
    expect(validateFixedExpenseTarget({ providerId: null, lspServiceId: "l1" })).toBeNull();
  });
  it("rechaza ninguno", () => {
    expect(validateFixedExpenseTarget({ providerId: null, lspServiceId: null })).toMatch(/proveedor o un servicio/i);
  });
  it("rechaza ambos", () => {
    expect(validateFixedExpenseTarget({ providerId: "p1", lspServiceId: "l1" })).toMatch(/uno solo/i);
  });
});

describe("obligationMatchesInvoice", () => {
  it("gasto LSP matchea por lspServiceId", () => {
    expect(
      obligationMatchesInvoice(
        { providerId: null, lspServiceId: "l1" },
        { providerId: "pX", lspServiceId: "l1" }
      )
    ).toBe(true);
  });
  it("gasto LSP NO matchea si difiere el lspServiceId", () => {
    expect(
      obligationMatchesInvoice(
        { providerId: null, lspServiceId: "l1" },
        { providerId: "pX", lspServiceId: "l2" }
      )
    ).toBe(false);
  });
  it("gasto por proveedor matchea por providerId", () => {
    expect(
      obligationMatchesInvoice(
        { providerId: "p1", lspServiceId: null },
        { providerId: "p1", lspServiceId: null }
      )
    ).toBe(true);
  });
  it("gasto por proveedor NO matchea si difiere el providerId", () => {
    expect(
      obligationMatchesInvoice(
        { providerId: "p1", lspServiceId: null },
        { providerId: "p2", lspServiceId: null }
      )
    ).toBe(false);
  });
  it("no matchea si la invoice no tiene el dato objetivo", () => {
    expect(
      obligationMatchesInvoice(
        { providerId: "p1", lspServiceId: null },
        { providerId: null, lspServiceId: null }
      )
    ).toBe(false);
  });
});

// ── Tipo de documento (spec 2026-09-17) ─────────────────────────────────────
// La factura y la retención del mismo proveedor conviven en el período: cada
// obligación sólo acepta boletas de su tipo, sin importar cuál llegó primero.
describe("obligationMatchesInvoice — tipo", () => {
  const mayoral = { providerId: "p1", lspServiceId: null };

  it("FACTURA no acepta una retención del mismo proveedor", () => {
    expect(obligationMatchesInvoice({ ...mayoral, kind: "FACTURA" }, { ...mayoral, docKind: "RETENCION" })).toBe(false);
  });

  it("RETENCION no acepta la factura", () => {
    expect(obligationMatchesInvoice({ ...mayoral, kind: "RETENCION" }, { ...mayoral, docKind: "FACTURA" })).toBe(false);
  });

  it("RETENCION acepta la retención", () => {
    expect(obligationMatchesInvoice({ ...mayoral, kind: "RETENCION" }, { ...mayoral, docKind: "RETENCION" })).toBe(true);
  });

  it("sin tipo de ninguno de los dos lados se comporta como FACTURA/FACTURA", () => {
    expect(obligationMatchesInvoice(mayoral, mayoral)).toBe(true);
  });
});

describe("validateFixedExpenseTarget — tipo", () => {
  it("un LSP no puede ser RETENCION", () => {
    expect(validateFixedExpenseTarget({ providerId: null, lspServiceId: "l1", kind: "RETENCION" })).toMatch(/retenci/i);
  });

  it("un proveedor sí", () => {
    expect(validateFixedExpenseTarget({ providerId: "p1", lspServiceId: null, kind: "RETENCION" })).toBeNull();
  });
});
