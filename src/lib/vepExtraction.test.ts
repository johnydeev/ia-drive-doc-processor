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

// ── Clasificación por códigos de renglón (spec 2026-09-11) ──────────────────
import { classifyVep, extractVepConceptCodes, extractVepContribuyenteCuit } from "./vepExtraction";

const VEP_SICOSS = `Tipo de Pago: Empleadores SICOSS - Saldo DJ
CUIT: 30-70200241-5
Generado por el Usuario: 27324998573
CONTRIBUCIONES SEG. SOCIAL (351) $896.406,81
EMPLEADOR-APORTES SEG. SOCIAL (301) $686.724,26
SEG.RIESGO DE TRABAJO L 24557 (312) $241.274,85
SEGURO DE VIDA COLECTIVO (28) $849,24
Importe total a pagar $2.188.815,06`;

const VEP_RETENCION = `Tipo de Pago: Vep Consolidado ARCA
CUIT: 30-70200241-5
SICORE-IMPTO.A LAS GANANCIAS (217) $272.940,60
SICORE - RETENCIONES Y PERCEPC (767) $1.439.990,90
RETENCIONES CONTRIB.SEG.SOCIAL (353) $822.851,94
Importe total a pagar $2.535.783,44`;

describe("extractVepConceptCodes", () => {
  it("lee los códigos entre paréntesis de los renglones", () => {
    expect(extractVepConceptCodes(VEP_SICOSS)).toEqual(["351", "301", "312", "28"]);
  });

  it("ignora paréntesis que no son códigos conocidos", () => {
    expect(extractVepConceptCodes("Detalle (ver anexo) (999) (12)")).toEqual([]);
  });
});

describe("classifyVep", () => {
  it("SICOSS puro → EMPLEADO", () => {
    expect(classifyVep(VEP_SICOSS)).toBe("EMPLEADO");
  });

  it("217/767/353 → RETENCION", () => {
    expect(classifyVep(VEP_RETENCION)).toBe("RETENCION");
  });

  it("consolidado con sólo ART (312) → EMPLEADO", () => {
    // Pueyrredón p12: "Vep Consolidado ARCA" con un único renglón, la ART del
    // encargado. "Consolidado" no dice nada; el código sí.
    expect(classifyVep("Tipo de Pago: Vep Consolidado ARCA\nSEG.RIESGO DE TRABAJO L 24557 (312) $609.793,62")).toBe("EMPLEADO");
  });

  it("216 (SIRE IVA) también es retención", () => {
    expect(classifyVep("SIRE - IVA (216) $642.557,74")).toBe("RETENCION");
  });

  it("SICOSS + 353 → MIXTO", () => {
    expect(classifyVep(VEP_SICOSS + "\nRETENCIONES CONTRIB.SEG.SOCIAL (353) $1")).toBe("MIXTO");
  });

  it("códigos fuera de ambas listas → DESCONOCIDO", () => {
    expect(classifyVep("INGRESOS BRUTOS (999) $84.861,28")).toBe("DESCONOCIDO");
  });

  it("sin paréntesis legibles → SIN_CODIGOS", () => {
    expect(classifyVep("Tipo de Pago: Empleadores SICOSS\nImporte total a pagar $1")).toBe("SIN_CODIGOS");
  });
});

describe("extractVepContribuyenteCuit", () => {
  it("devuelve el CUIT rotulado 'CUIT:' en dígitos", () => {
    expect(extractVepContribuyenteCuit(VEP_SICOSS)).toBe("30702002415");
  });

  it("no toma el de 'Generado por el Usuario'", () => {
    expect(extractVepContribuyenteCuit("Generado por el Usuario: 27324998573\nCUIT: 30-71001560-7")).toBe("30710015607");
  });

  it("null si no hay rótulo", () => {
    expect(extractVepContribuyenteCuit("Generado por el Usuario: 27324998573")).toBeNull();
  });

  it("null si el CUIT rotulado no pasa el checksum", () => {
    expect(extractVepContribuyenteCuit("CUIT: 30-70200241-9")).toBeNull();
  });
});
