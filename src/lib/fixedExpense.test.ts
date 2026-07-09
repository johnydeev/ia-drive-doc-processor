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
