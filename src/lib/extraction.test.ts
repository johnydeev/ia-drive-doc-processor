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

describe("identifyLSPProvider — falso positivo de PERSONAL", () => {
  // Factura de IPLAN (NSS SA): dice 'CÓDIGO DE GESTIÓN PERSONAL', pero NO es
  // Telecom/Personal. Antes el router la clasificaba como PERSONAL (por la
  // palabra suelta) → la trataba como LSP, buscaba nro de cliente y caía en
  // Sin Asignar. Debe ser factura común (null) → matchea NSS SA por CUIT.
  const IPLAN = [
    "FACTURA A CÓDIGO N°: 1",
    "NSS SA",
    "Internet Giga+ Abono 107761.69",
    "CONS DE PROPS DE LA CALLE BME MITRE 1223 Y 1225",
    "CUIT 30702652975",
    "CLIENTE N° 664688",
    "CÓDIGO DE GESTIÓN PERSONAL: 6646881",
  ].join("\n");

  it("NO detecta PERSONAL en una factura de IPLAN (solo 'GESTIÓN PERSONAL')", () => {
    expect(identifyLSPProvider(IPLAN)).toBeNull();
  });

  it("sigue detectando Personal/Telecom real (TELECOM ARGENTINA)", () => {
    const personal = "TELECOM ARGENTINA S.A.\nFactura Personal\nN° de Referencia de Pago 12345";
    expect(identifyLSPProvider(personal)).toBe("PERSONAL");
  });

  it("sigue detectando Personal cuando la marca aparece sola (no 'gestión personal')", () => {
    const personal = "MI PERSONAL\nFactura de telefonía\nVencimiento para el pago";
    expect(identifyLSPProvider(personal)).toBe("PERSONAL");
  });
});

describe("buildExtractionPrompt — prompt sindical", () => {
  // El proveedor sindical se identifica por NOMBRE (del encabezado). El CUIT que
  // figura en el documento es del CONSORCIO/edificio contribuyente (cada edificio
  // tiene el suyo), NO del proveedor → providerTaxId debe ser null y el CUIT va a
  // allTaxIds para matchear el edificio.
  it("para SUTERH fija provider por nombre y NO le asigna CUIT al proveedor", () => {
    const prompt = buildExtractionPrompt(SUTERH_TEXT);
    expect(prompt).toContain("provider: siempre 'SUTERH'");
    expect(prompt).toContain("providerTaxId: null");
    expect(prompt).not.toContain("providerTaxId: siempre '30-54675623-4'");
  });

  it("para SERACARH fija provider SERACARH (no FATERYH)", () => {
    const prompt = buildExtractionPrompt(SERACARH_TEXT);
    expect(prompt).toContain("provider: siempre 'SERACARH'");
    expect(prompt).toContain("providerTaxId: null");
  });

  it("para FATERYH fija provider FATERYH", () => {
    const prompt = buildExtractionPrompt(FATERYH_TEXT);
    expect(prompt).toContain("provider: siempre 'FATERYH'");
  });

  it("instruye que el CUIT del documento es del consorcio (va a allTaxIds)", () => {
    const prompt = buildExtractionPrompt(SUTERH_TEXT);
    expect(prompt).toContain("allTaxIds");
    expect(prompt.toLowerCase()).toContain("consorcio");
  });
});
