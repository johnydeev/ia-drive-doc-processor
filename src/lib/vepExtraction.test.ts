import { describe, expect, it } from "vitest";
import { buildVepPrompt } from "./vepExtraction";

describe("buildVepPrompt", () => {
  const prompt = buildVepPrompt("VEP\nVolante Electrónico de Pago\nNro. VEP: 1570130517");

  it("fija el proveedor en ARCA en vez de dejarlo al modelo", () => {
    expect(prompt).toContain("ARCA");
    expect(prompt).toContain('"provider": "ARCA"');
  });

  it("nombra los rótulos exactos del papel", () => {
    expect(prompt).toContain("Nro. VEP");
    expect(prompt).toContain("Día de Expiración");
    expect(prompt).toContain("Importe total a pagar");
  });

  it("prohíbe usar el CUIT de 'Generado por el Usuario'", () => {
    // Es el CUIT de la administradora y viaja en TODOS los VEP.
    expect(prompt).toContain("Generado por el Usuario");
    expect(prompt).toMatch(/NO .*(us|tom)/i);
  });

  it("pide el CUIT del contribuyente como consorcio", () => {
    expect(prompt).toContain("contribuyente");
  });

  it("incluye el texto del documento", () => {
    expect(prompt).toContain("Nro. VEP: 1570130517");
  });
});
