import { describe, it, expect } from "vitest";
import { parseAfipBarcodes, extractEmitterCuitFromBarcode } from "@/lib/afipBarcode";

/**
 * Caso real: factura B 0010-00051837 de BPACE E HIJOS S.R.L. (ARAOZ 192), que
 * rebotó a Sin Asignar porque su membrete es una imagen y el único CUIT en texto
 * era el del consorcio receptor.
 */
const BPACE_BARCODE = "3070741550506001086095857203130202603121";
const BPACE_TEXT = [
  "FACTURA",
  "Nro. 0010-00051837",
  "Nombre : CONSORCIO DE PROPIETARIOS (000060)",
  "I.V.A. : Sujeto no categorizado - CUIT: 30-55007155-6",
  BPACE_BARCODE,
  "Nro. de CAE: 86095857203130 - Fecha de Vto.: 12/03/26 Total : 104,500.00",
].join("\n");

describe("parseAfipBarcodes", () => {
  it("desarma el código real en sus tramos (RG 1702)", () => {
    const [barcode] = parseAfipBarcodes(BPACE_TEXT);

    expect(barcode).toMatchObject({
      cuit: "30-70741550-5",
      tipoComprobante: "06",
      puntoVenta: "0010",
      cae: "86095857203130",
      caeVto: "20260312",
      dv: "1",
      corroborated: true,
    });
  });

  it("descarta un código de pago electrónico (el falso positivo real de Edesur)", () => {
    // 40 dígitos que NO son un comprobante: el CUIT daría 00-90001061-1, con
    // prefijo inexistente y checksum fallado.
    const text = "CODIGO DE PAGO 0090001061106001086095857203130202603121";

    expect(parseAfipBarcodes(text)).toEqual([]);
  });

  it("descarta un código cuyo vencimiento de CAE no es una fecha", () => {
    // Mismo CUIT válido, pero el tramo de fecha es 99999999.
    const text = "3070741550506001086095857203130999999991";

    expect(parseAfipBarcodes(text)).toEqual([]);
  });

  it("no pega dígitos separados por espacios (no inventa códigos)", () => {
    const text = "3070741550 5060010860958572 03130202603121";

    expect(parseAfipBarcodes(text)).toEqual([]);
  });

  it("devuelve vacío si no hay ninguna corrida de 40 dígitos", () => {
    expect(parseAfipBarcodes("FACTURA B Nro. 0010-00051837 CAE 86095857203130")).toEqual([]);
    expect(parseAfipBarcodes(null)).toEqual([]);
  });
});

describe("extractEmitterCuitFromBarcode", () => {
  it("devuelve el CUIT del emisor cuando el código corrobora lo impreso", () => {
    expect(extractEmitterCuitFromBarcode(BPACE_TEXT)).toBe("30-70741550-5");
  });

  it("rechaza el código si el CAE impreso NO coincide con el del código", () => {
    // Un CAE impreso distinto significa que esos 40 dígitos son otra cosa.
    const text = [
      "Nro. 0007-00000001",
      BPACE_BARCODE,
      "Nro. de CAE: 11111111111111",
    ].join("\n");

    expect(extractEmitterCuitFromBarcode(text)).toBeNull();
  });

  it("acepta el código estructuralmente válido si el documento no imprime CAE ni número de comprobante", () => {
    expect(extractEmitterCuitFromBarcode(`FACTURA\n${BPACE_BARCODE}`)).toBe("30-70741550-5");
  });

  it("corrobora también por punto de venta cuando el CAE no está impreso", () => {
    const text = `FACTURA Nro. 0010-00051837\n${BPACE_BARCODE}`;

    expect(extractEmitterCuitFromBarcode(text)).toBe("30-70741550-5");
  });

  it("devuelve null cuando no hay código", () => {
    expect(extractEmitterCuitFromBarcode("factura sin código de barras")).toBeNull();
  });
});
