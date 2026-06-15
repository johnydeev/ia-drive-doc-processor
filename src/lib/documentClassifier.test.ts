import { describe, it, expect } from "vitest";
import { classifyDocumentType } from "@/lib/documentClassifier";

describe("classifyDocumentType", () => {
  it("boleta común (monto + CUIT + FACTURA) → boleta", () => {
    expect(
      classifyDocumentType("FACTURA B N° 0001 CUIT 30-12345678-9 TOTAL A PAGAR $ 12.500,00")
    ).toBe("boleta");
  });

  it("liquidación de servicio público → boleta", () => {
    expect(
      classifyDocumentType("EDESUR S.A. LIQUIDACION DE SERVICIOS PUBLICOS TOTAL $ 8.000 VENCIMIENTO 10/05")
    ).toBe("boleta");
  });

  it("certificado de fumigación SIN monto → not_boleta", () => {
    expect(
      classifyDocumentType("CERTIFICADO DE FUMIGACION Y CONTROL DE PLAGAS - Edificio Thames 647")
    ).toBe("not_boleta");
  });

  it("oblea de rúbrica de libros → not_boleta", () => {
    expect(
      classifyDocumentType("OBLEA DE RUBRICA DE LIBROS - DISPOSICION N 123 - Inspeccion General de Justicia")
    ).toBe("not_boleta");
  });

  it("plano de edificio → not_boleta", () => {
    expect(
      classifyDocumentType("PLANO DE OBRA - PLANTA BAJA - ESCALA 1:100 - Municipalidad")
    ).toBe("not_boleta");
  });

  it("factura de la empresa de fumigación CON monto → boleta (la señal de boleta gana)", () => {
    expect(
      classifyDocumentType("FACTURA C N° 0005 SERVICIO DE FUMIGACION CUIT 20-11111111-2 TOTAL A PAGAR $ 30.000")
    ).toBe("boleta");
  });

  it("texto vacío → boleta (sesgo conservador, no corta)", () => {
    expect(classifyDocumentType("")).toBe("boleta");
  });
});
