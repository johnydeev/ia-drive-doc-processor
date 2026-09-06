import { describe, it, expect } from "vitest";
import { classifyDocumentType, detectDecisiveNotBoleta } from "@/lib/documentClassifier";

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

/**
 * Textos REALES (recortados) de los papeles que el owner apartó en Sin Asignar.
 * Se calibró sobre 4 VEP y 5 LSD: escribir los marcadores de memoria no habría
 * servido — los LSD, por ejemplo, NO dicen "liquidación de sueldos digital" en ningún
 * lado del texto extraíble.
 */
const VEP_REAL = `VEP
Volante Electrónico de Pago
Atención: este VEP esta pendiente de pago y expira en 30 día/s
Nro. VEP: 1647417780
Organismo Recaudador: ARCA
Tipo de Pago: Empleadores SICOSS - Saldo DJ
CUIT: 30-71717054-3
Período: 2026-05
Día de Expiración: 2026-08-01
CONTRIBUCIONES OBRA SOCIAL (352) $1.855.522,44
Importe total a pagar $4.267.254,03`;


describe("detectDecisiveNotBoleta", () => {
  // La capa 0 quedó VACÍA el 2026-09-03. Nació con el VEP y el LSD, y los dos
  // salieron al pasar a procesarse: hoy los detecta `identifyLSPProvider`, y su
  // cobertura vive en `extraction.test.ts`. El mecanismo se conserva para el
  // próximo formulario que haya que descartar, así que este test fija que sigue
  // existiendo y que no descarta nada.
  it("hoy no descarta ningún tipo: el VEP y el LSD pasaron a procesarse", () => {
    expect(detectDecisiveNotBoleta(VEP_REAL)).toBeNull();
    expect(
      detectDecisiveNotBoleta("FACTURA B N° 0001 CUIT 30-12345678-9 TOTAL A PAGAR $ 12.500,00 CAE 7412")
    ).toBeNull();
    expect(detectDecisiveNotBoleta("")).toBeNull();
  });
});
