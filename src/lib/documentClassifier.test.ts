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
 * servido — los LSD, por ejemplo, NO dicen "libro de sueldos digital" en ningún
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

const LSD_REAL = `EMPRESA DOMICILIO FISCAL
PERIODO PROVINCIA
NRO.LIQUIDACIÓN
ACTIVIDAD PPAL
30-52063978-7 - CONSORCIO COPROPIETARIOS AV ALMIRANTE B BROWN ALMTE AV. 706 06A
202607 CIUDAD AUTONOMA BUENOS AIRES
949920 - SERVICIOS DE CONSORCIOS DE EDIFICIOS
LEGAJO CUIL APELLIDO Y NOMBRE FECHA INGRESO FECHA CESE DOCUMENTO FECHA NACIMIENTO
IDENTIFICADOR ÚNICO DEL LIBRO 000000045900718 FECHA DE EMISIÓN DEL LIBRO 07/08/2026
1 27-18116846-9 BRITEZ, PAULA ADELA 02/02/2010 - DNI 18.116.846
0000000001 - Sueldo Basico 30,00 $ 1.318.092,00 0,00 0,00`;

describe("detectDecisiveNotBoleta", () => {
  it("VEP real → VEP (pese a tener $, IMPORTE, VENCIMIENTO y CUIT)", () => {
    expect(detectDecisiveNotBoleta(VEP_REAL)).toBe("VEP");
  });

  it("LSD real → LSD (pese a tener $ y CUIT)", () => {
    expect(detectDecisiveNotBoleta(LSD_REAL)).toBe("LSD");
  });

  it("una factura común no dispara ningún tipo", () => {
    expect(
      detectDecisiveNotBoleta("FACTURA B N° 0001 CUIT 30-12345678-9 TOTAL A PAGAR $ 12.500,00 CAE 7412")
    ).toBeNull();
  });

  it("una boleta de servicio no dispara ningún tipo", () => {
    expect(
      detectDecisiveNotBoleta("EDESUR S.A. LIQUIDACION DE SERVICIOS PUBLICOS TOTAL $ 8.000 VENCIMIENTO 10/05")
    ).toBeNull();
  });

  // ── El falso positivo que hay que evitar sí o sí ──────────────────────────
  // El F931 de ARCA se extrae con 2 páginas porque el "Importe total a pagar"
  // está en el VEP de la página 2. O sea su texto CONTIENE "Volante Electrónico
  // de Pago", pero es un gasto real que se paga y tiene prompt propio.
  // La regla: el marcador de VEP sólo cuenta en el ENCABEZADO del documento.
  it("F931 de ARCA con el VEP en la página 2 → NO es un VEP", () => {
    const f931 = `ARCA - DECLARACIÓN JURADA
F. 931 - SEGURIDAD SOCIAL
CUIT: 30-52063978-7 CONSORCIO DE PROPIETARIOS
Período: 07/2026
Total de contribuciones de seguridad social $ 1.200.000,00
Cantidad de empleados: 2
Remuneración imponible 1 $ 3.000.000,00
${"Detalle de la declaración jurada. ".repeat(20)}
-- 2 of 2 --
VEP
Volante Electrónico de Pago
Nro. VEP: 1654020372
Importe total a pagar $1.200.000,00`;

    expect(detectDecisiveNotBoleta(f931)).toBeNull();
  });

  it("no se confunde por la palabra 'sueldos' suelta en una factura", () => {
    expect(
      detectDecisiveNotBoleta("FACTURA C 0001-00000045 Servicio de liquidación de sueldos $ 90.000 CAE 123")
    ).toBeNull();
  });

  it("tolera el texto sin acentos (OCR)", () => {
    expect(detectDecisiveNotBoleta("VEP\nVolante Electronico de Pago\nNro. VEP: 1")).toBe("VEP");
  });
});
