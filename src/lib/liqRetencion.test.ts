import { describe, expect, it } from "vitest";
import { isLiqRetencionText, parseLiqRetencion, toExtractedDocument } from "./liqRetencion";

/**
 * Texto de pdf-parse de un paquete real de 5 páginas (Boedo 414 / Mayoral,
 * septiembre 2026), recortado a las líneas que importan. Una línea por campo,
 * con el monto al lado: así lo devuelve el extractor del worker.
 */
export const MAYORAL = `CONSORCIO DE PROPIETARIOS BOEDO 414 - C.A.B.A.
C.U.I.T. N* 30-54675623-4
PAGO CORRESPONDIENTE AL MES DE SEPTIEMBRE 2026
NOMBRE DEL PROVEEDOR: MAYORAL SEGURIDAD S.R.L.
C.U.I.T. N* 30-71530019-9
FACTURA B N*: 00001-00001848
FECHA: 31/08/2026
IMPORTE TOTAL: 7.404.713,01
RETENCION:
IVA 642.557,74
s/fra. 0001-00001848
GANANCIAS 121.048,55
s/fra. 0001-00001848
SEGURIDAD SOCIAL 367.175,85
s/fra. 0001-00001848
SUBTOTAL RETENCIONES 1.130.782,14
IMPORTE NETO 6.273.930,87
SE ADJUNTA COMPROBANTES DE RETENCIONES EFECTUADAS.

-- 1 of 5 --

SI.CO.RE. - Sistema de Control
de Retenciones
A. - Datos del Agente de Retención
B. - Datos del Sujeto Retenido
30-54675623-4
30-71530019-9 Nº

-- 5 of 5 --

VEP
Volante Electrónico de Pago
Nro. VEP Consolidado: 1679299135
Organismo Recaudador: ARCA
Tipo de Pago: Vep Consolidado ARCA
CUIT: 30-54675623-4
Generado por el Usuario: 27324998573
Cantidad de SubVeps: 3
Día de Expiración: 2026-10-10
SICORE-IMPTO.A LAS GANANCIAS (217) $121.048,55
SIRE - IVA (216) $642.557,74
RETENCIONES CONTRIB.SEG.SOCIAL (353) $367.175,85
Importe total a pagar $1.130.782,14`;

/** Paquete de 3 páginas (Pueyrredón / Dogo): una sola retención, VEP sin "Consolidado". */
const DOGO = `CONSORCIO DE PROPIETARIOS Av. PUEYRREDON 2418/22 - C.A.B.A.
C.U.I.T. N* 30-71001560-7
PAGO CORRESPONDIENTE AL MES DE SEPTIEMBRE 2026
NOMBRE DEL PROVEEDOR: COOP.TRAB.SEG y VIGILANCIA DOGO ARG.LTDA.
C.U.I.T. N* 30-66293417-4
FACTURA B N*: 0002-00007196
FECHA: 03/09/2026
IMPORTE TOTAL: 8.197.317,85
RETENCION:
IVA 711.337,50
s/fra. 0002-00007196
SUBTOTAL RETENCIONES 711.337,50
IMPORTE NETO 7.485.980,35
SE ADJUNTA COMPROBANTES DE RETENCIONES EFECTUADAS.
VEP
Volante Electrónico de Pago
Nro. VEP: 1679256980
Tipo de Pago: Retenciones IVA - Pago a cuenta
CUIT: 30-71001560-7
Generado por el Usuario: 27324998573
Día de Expiración: 2026-10-10
SICORE - RETENCIONES Y PERCEPC (767) $711.337,50
Importe total a pagar $711.337,50`;

describe("isLiqRetencionText", () => {
  it("reconoce la planilla por sus tres marcadores", () => {
    expect(isLiqRetencionText(MAYORAL.toUpperCase())).toBe(true);
  });

  it("una factura con la palabra retención en el detalle no es planilla", () => {
    expect(isLiqRetencionText("FACTURA B\nIMPORTE TOTAL 1.000,00\nDETALLE: GASTOS Y RETENCIONES")).toBe(false);
  });
});

describe("parseLiqRetencion", () => {
  it("lee el paquete de 5 páginas (Mayoral)", () => {
    const liq = parseLiqRetencion(MAYORAL)!;
    expect(liq).toMatchObject({
      consortiumCuit: "30546756234",
      providerName: "MAYORAL SEGURIDAD S.R.L.",
      providerCuit: "30715300199",
      invoiceNumber: "00001-00001848",
      invoiceTotal: 7404713.01,
      subtotal: 1130782.14,
      vepNumber: "1679299135",
      expiresOn: "2026-10-10",
    });
    expect(liq.lines).toEqual([
      { label: "IVA", amount: 642557.74 },
      { label: "GANANCIAS", amount: 121048.55 },
      { label: "SEGURIDAD SOCIAL", amount: 367175.85 },
    ]);
  });

  it("lee el paquete de 3 páginas (Dogo, Nro. VEP sin 'Consolidado')", () => {
    const liq = parseLiqRetencion(DOGO)!;
    expect(liq.providerCuit).toBe("30662934174");
    expect(liq.subtotal).toBe(711337.5);
    expect(liq.vepNumber).toBe("1679256980");
    expect(liq.lines).toEqual([{ label: "IVA", amount: 711337.5 }]);
  });

  it("null sin subtotal", () => {
    expect(parseLiqRetencion(MAYORAL.replace("SUBTOTAL RETENCIONES 1.130.782,14\n", ""))).toBeNull();
  });

  it("null si el CUIT de la empresa no pasa checksum", () => {
    expect(parseLiqRetencion(MAYORAL.replace("30-71530019-9", "30-71530019-1"))).toBeNull();
  });
});

describe("toExtractedDocument", () => {
  const doc = toExtractedDocument(parseLiqRetencion(MAYORAL)!);

  it("sólo dos CUIT: consorcio y empresa (nunca la administradora)", () => {
    expect(doc.allTaxIds).toEqual(["30-54675623-4", "30-71530019-9"]);
  });

  it("monto = subtotal de retenciones, no el total de la factura", () => {
    expect(doc.amount).toBe(1130782.14);
  });

  it("nro. de boleta = Nro. VEP, vencimiento = expiración", () => {
    expect(doc.boletaNumber).toBe("1679299135");
    expect(doc.dueDate).toBe("2026-10-10");
  });

  it("sin VEP legible usa RET-<factura>", () => {
    const sinVep = toExtractedDocument(parseLiqRetencion(MAYORAL.replace("Nro. VEP Consolidado: 1679299135\n", ""))!);
    expect(sinVep.boletaNumber).toBe("RET-00001-00001848");
  });

  it("detalle con factura y desglose; resto de campos fijos", () => {
    expect(doc.detail).toBe(
      "Retenciones s/fra. 00001-00001848 · IVA 642.557,74 · GANANCIAS 121.048,55 · SEGURIDAD SOCIAL 367.175,85"
    );
    expect(doc.provider).toBe("MAYORAL SEGURIDAD S.R.L.");
    expect(doc.providerTaxId).toBe("30-71530019-9");
    expect(doc.consortium).toBeNull();
    expect(doc.clientNumber).toBeNull();
    expect(doc.isBoleta).toBe(true);
  });
});
