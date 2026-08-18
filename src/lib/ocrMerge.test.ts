import { describe, it, expect } from "vitest";
import { ocrAddsNewCuits, shouldMergeOcrText } from "@/lib/ocrMerge";

/**
 * Caso real: factura de ROMERO MIGUEL ANGEL (Fumigaciones Miguel) a CASTRO BARROS
 * 1310, emitida por GESTIONPRO. El cuerpo viene en texto (ítems, importes, CAE)
 * pero el membrete —razón social y CUIT del emisor— es una imagen. El único CUIT
 * suelto del texto directo es el del CONSORCIO receptor.
 */
const DIRECT_GESTIONPRO = [
  "Control integral de plagas",
  "Periodo: Junio 2026",
  "Nº00002-00208193",
  "CAE Nº: 86227430866757",
  "30-71741718-2 EXENTO",
  "CONSORCIO DE COPROPIETARIOS EDIFICIO CASTRO BARROS",
  "CASTRO BARROS AV. 1310",
].join("\n");

/** Lo que el OCR saca del membrete: corto, pero trae el CUIT del emisor. */
const OCR_MEMBRETE = "ROMERO MIGUEL ANGEL Fumigaciones Miguel CUIT: 20-16654129-9";

describe("ocrAddsNewCuits", () => {
  it("detecta que el OCR aporta el CUIT del emisor que faltaba", () => {
    expect(ocrAddsNewCuits(DIRECT_GESTIONPRO, OCR_MEMBRETE)).toBe(true);
  });

  it("es falso cuando el OCR solo repite CUITs que ya estaban", () => {
    expect(ocrAddsNewCuits(DIRECT_GESTIONPRO, "CONSORCIO ... CUIT 30-71741718-2")).toBe(false);
  });

  it("es falso cuando el OCR no trae ningún CUIT", () => {
    expect(ocrAddsNewCuits(DIRECT_GESTIONPRO, "texto ilegible sin datos")).toBe(false);
  });

  it("ignora números con forma de CUIT pero checksum inválido (ruido del OCR)", () => {
    expect(ocrAddsNewCuits(DIRECT_GESTIONPRO, "CUIT: 20-16654129-1")).toBe(false);
  });

  it("compara por dígitos: el mismo CUIT con otro formato no es nuevo", () => {
    expect(ocrAddsNewCuits("CUIT 20-16654129-9", "CUIT 20166541299")).toBe(false);
  });
});

describe("shouldMergeOcrText", () => {
  it("mezcla cuando el OCR es más largo (comportamiento histórico)", () => {
    expect(shouldMergeOcrText("corto", "un texto de OCR bastante más largo")).toBe(true);
  });

  it("mezcla aunque el OCR sea MÁS CORTO, si aporta un CUIT nuevo", () => {
    // El bug que motivó el cambio: el texto directo es largo (todo el cuerpo de la
    // factura) y el OCR corto, así que se descartaba entero — con el CUIT adentro.
    expect(OCR_MEMBRETE.length).toBeLessThan(DIRECT_GESTIONPRO.length);
    expect(shouldMergeOcrText(DIRECT_GESTIONPRO, OCR_MEMBRETE)).toBe(true);
  });

  it("NO mezcla si el OCR es más corto y no aporta ningún CUIT", () => {
    expect(shouldMergeOcrText(DIRECT_GESTIONPRO, "ruido")).toBe(false);
  });

  it("NO mezcla si el OCR está vacío", () => {
    expect(shouldMergeOcrText(DIRECT_GESTIONPRO, "")).toBe(false);
  });
});
