import { describe, it, expect } from "vitest";
import { identifyLSPProvider, buildExtractionPrompt } from "@/lib/extraction";

// Encabezados REALES extraídos de los PDFs de muestra (pdf-parse, texto plano).
const SUTERH_TEXT = [
  "SINDICATO UNICO DE TRABAJADORES DE EDIFICIOS DE RENTA Y HORIZONTAL F0201",
  "CUIT: 30-54675623-4 (24264)",
  "CONSORCIO: AVDA BOEDO 00410 /14-CIUDAD DE BUENOS AIRES-",
  "CAPITAL FEDERAL",
  "PERIODO: 05/2026 DECLARACION: 0 - Original",
  "Nº BOLETA: 26-00240005 VENCIMIENTO: 12/06/2026",
  "CPF aporte 20619.07 0.00 20619.07",
  "Aporte sindical 41238.14 0.00 41238.14",
  "TOTAL A PAGAR: 92785.81",
  "ESTA BOLETA SE DEBITARA DIRECTAMENTE EN SU CUENTA BANCARIA INFORMADA.",
].join("\n");

const FATERYH_TEXT = [
  "FEDERACION ARGENTINA DE TRABAJADORES DE EDIFICIOS DE RENTA Y HORIZONTAL F0101",
  "CUIT: 30-54675623-4 (24264) 2/2",
  "CONSORCIO: AVDA BOEDO 00410 /14-CIUDAD DE BUENOS AIRES-",
  "PERIODO: 05/2026 DECLARACION: 0 - Original",
  "Nº BOLETA: 26-00294395 VENCIMIENTO: 12/06/2026",
  "FMVDD aporte 20619.07 0.00 20619.07",
  "Contrib. Solidaria OS CCT 589/10 44962.00 0.00 44962.00",
  "TOTAL A PAGAR: 178985.95",
].join("\n");

const SERACARH_TEXT = [
  "FEDERACION ARGENTINA DE TRABAJADORES DE EDIFICIOS DE RENTA Y HORIZONTAL F0106",
  "CUIT: 30-54675623-4 (24264) 1/2",
  "CONSORCIO: AVDA BOEDO 00410 /14-CIUDAD DE BUENOS AIRES-",
  "PERIODO: 05/2026 DECLARACION: 0 - Original",
  "Nº BOLETA: 26-00284923 VENCIMIENTO: 12/06/2026",
  "SERACARH Contribución 10309.53 0.00 10309.53",
  "TOTAL A PAGAR: 10309.53",
].join("\n");

describe("identifyLSPProvider — boletas sindicales (SUTERH/FATERYH/SERACARH)", () => {
  it("detecta SUTERH (F0201 / Sindicato Único)", () => {
    expect(identifyLSPProvider(SUTERH_TEXT)).toBe("SUTERH");
  });

  it("detecta FATERYH (F0101 / Federación)", () => {
    expect(identifyLSPProvider(FATERYH_TEXT)).toBe("FATERYH");
  });

  it("detecta SERACARH (F0106, emitida por FATERYH)", () => {
    expect(identifyLSPProvider(SERACARH_TEXT)).toBe("SERACARH");
  });

  it("regresión: una factura común sigue sin ser LSP", () => {
    const factura = "FACTURA C\nLUZARDO JAVIEL JOSE EMILIO\nCUIT: 20940370362\nImporte Total: 50000";
    expect(identifyLSPProvider(factura)).toBeNull();
  });

  it("regresión: Edesur sigue detectándose", () => {
    expect(identifyLSPProvider("EDESUR S.A. Liquidación de Servicios Públicos")).toBe("EDESUR");
  });
});

describe("buildExtractionPrompt — prompt sindical", () => {
  it("para SUTERH la instrucción fija provider y CUIT recaudador", () => {
    const prompt = buildExtractionPrompt(SUTERH_TEXT);
    expect(prompt).toContain("provider: siempre 'SUTERH'");
    expect(prompt).toContain("providerTaxId: siempre '30-54675623-4'");
  });

  it("para SERACARH la instrucción fija provider SERACARH (no FATERYH)", () => {
    const prompt = buildExtractionPrompt(SERACARH_TEXT);
    expect(prompt).toContain("provider: siempre 'SERACARH'");
    expect(prompt).toContain("providerTaxId: siempre '30-54675623-4'");
  });

  it("para FATERYH la instrucción fija provider FATERYH", () => {
    const prompt = buildExtractionPrompt(FATERYH_TEXT);
    expect(prompt).toContain("provider: siempre 'FATERYH'");
  });
});
