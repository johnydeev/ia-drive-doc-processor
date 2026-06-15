import { describe, it, expect } from "vitest";
import { markNotBoleta, appendNoAmountTag, isMissingAmount } from "@/lib/documentValidation";

describe("markNotBoleta", () => {
  it("antepone el prefijo [NO BOLETA] al nombre", () => {
    expect(markNotBoleta("boleta.pdf")).toBe("[NO BOLETA] boleta.pdf");
  });
});

// Tests de regresión mínimos de los helpers existentes (no cambian).
describe("documentValidation existente", () => {
  it("isMissingAmount: null es sin monto; 0 es válido", () => {
    expect(isMissingAmount(null)).toBe(true);
    expect(isMissingAmount(0)).toBe(false);
  });
  it("appendNoAmountTag agrega ' - SIN MONTO' antes de la extensión", () => {
    expect(appendNoAmountTag("x.pdf")).toBe("x - SIN MONTO.pdf");
  });
});
