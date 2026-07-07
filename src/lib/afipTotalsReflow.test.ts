import { describe, it, expect } from "vitest";
import { reflowAfipTotals } from "@/lib/afipTotalsReflow";

// Bloques reales extraídos con pdf-parse de comprobantes AFIP que caían a
// "SIN MONTO". El número del Importe Total queda flotando ARRIBA de un rótulo
// "Importe Total: $" vacío; el reflow debe pegarlo al rótulo.

describe("reflowAfipTotals", () => {
  it("pega el Importe Total a su rótulo (caso Subtotal=Total, Otros=0)", () => {
    const text = [
      "1,00 unidades 85000,00 85000,00\t0,00 0,00",
      "0,00",
      "85000,00",
      "85000,00",
      "Subtotal: $",
      "Importe Otros Tributos: $",
      "Importe Total: $",
      "CAE N°:",
    ].join("\n");

    const out = reflowAfipTotals(text);
    expect(out).toContain("Importe Total: $ 85000,00");
  });

  it("funciona con separador de miles y otro importe", () => {
    const text = [
      "0,00",
      "207000,00",
      "207000,00",
      "Subtotal: $",
      "Importe Otros Tributos: $",
      "Importe Total: $",
    ].join("\n");

    const out = reflowAfipTotals(text);
    expect(out).toContain("Importe Total: $ 207000,00");
  });

  it("reescribe las 3 copias (Original/Duplicado/Triplicado) del comprobante", () => {
    const block = [
      "0,00",
      "90000,00",
      "90000,00",
      "Subtotal: $",
      "Importe Otros Tributos: $",
      "Importe Total: $",
    ].join("\n");
    const text = [block, block, block].join("\n");

    const out = reflowAfipTotals(text);
    const matches = out.match(/Importe Total: \$ 90000,00/g) ?? [];
    expect(matches.length).toBe(3);
  });

  it("no toca un Importe Total que ya trae su número inline", () => {
    const text = "Importe Total: $ 12345,67";
    expect(reflowAfipTotals(text)).toBe(text);
  });

  it("no rompe texto sin bloque de totales AFIP (no-op)", () => {
    const text = "EDESUR\nCliente Nº 12345\nVencimiento 10/07/2026";
    expect(reflowAfipTotals(text)).toBe(text);
  });

  it("no inventa monto si arriba del rótulo Subtotal no hay número", () => {
    const text = ["Otra cosa", "Subtotal: $", "Importe Otros Tributos: $", "Importe Total: $"].join("\n");
    const out = reflowAfipTotals(text);
    expect(out).toContain("Importe Total: $");
    expect(out).not.toMatch(/Importe Total: \$\s+\d/);
  });
});
