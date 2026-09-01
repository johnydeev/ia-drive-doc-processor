import { describe, it, expect } from "vitest";
import { markNotBoleta, appendNoAmountTag, appendTag, isMissingAmount } from "@/lib/documentValidation";

describe("markNotBoleta", () => {
  it("antepone el prefijo [NO BOLETA] al nombre", () => {
    expect(markNotBoleta("boleta.pdf")).toBe("[NO BOLETA] boleta.pdf");
  });

  it("es IDEMPOTENTE: no apila el prefijo al reprocesar", () => {
    expect(markNotBoleta("[NO BOLETA] boleta.pdf")).toBe("[NO BOLETA] boleta.pdf");
  });

  it("reemplaza el tipo cuando el archivo ya venía etiquetado con otro", () => {
    expect(markNotBoleta("[NO BOLETA - VEP] x.pdf", "LSD")).toBe("[NO BOLETA - LSD] x.pdf");
  });

  it("agrega el tipo cuando se lo pasan", () => {
    expect(markNotBoleta("vep.pdf", "VEP")).toBe("[NO BOLETA - VEP] vep.pdf");
  });

  it("no apila el prefijo con tipo", () => {
    expect(markNotBoleta("[NO BOLETA - VEP] vep.pdf", "VEP")).toBe("[NO BOLETA - VEP] vep.pdf");
  });

  it("un prefijo con tipo se limpia al volver al genérico", () => {
    expect(markNotBoleta("[NO BOLETA - PRESUPUESTO] x.pdf")).toBe("[NO BOLETA] x.pdf");
  });
});

// Tests de regresión mínimos de los helpers existentes (no cambian).
describe("documentValidation existente", () => {
  it("isMissingAmount: null es sin monto; 0 es válido", () => {
    expect(isMissingAmount(null)).toBe(true);
    expect(isMissingAmount(0)).toBe(false);
  });
  it("appendNoAmountTag agrega ' - SIN MONTO' antes de la extensión", () => {
    expect(appendNoAmountTag("x.pdf")).toBe("x - SIN MONTO.pdf");
  });
});

describe("appendTag (etiquetado idempotente)", () => {
  it("no apila las etiquetas nuevas de CUIT al reprocesar", () => {
    // Producción 2026-08-28: una boleta reprocesada tres veces terminaría como
    // "x - CUIT DE ... - CUIT DE ... - CUIT DE ....pdf" si el tag no se limpia.
    expect(
      appendTag("FcB 00002033 - CUIT DE CONSORCIO NO REGISTRADO EN DB.pdf", "CUIT DE CONSORCIO NO REGISTRADO EN DB")
    ).toBe("FcB 00002033 - CUIT DE CONSORCIO NO REGISTRADO EN DB.pdf");
  });

  it("reemplaza una etiqueta vieja por la nueva de CUIT", () => {
    expect(
      appendTag("FcB 00002033 - CONSORCIO SIN REGISTRAR.pdf", "CUIT DE CONSORCIO NO REGISTRADO EN DB")
    ).toBe("FcB 00002033 - CUIT DE CONSORCIO NO REGISTRADO EN DB.pdf");
  });

  it("reemplaza una etiqueta de CUIT por otra cuando cambia el motivo", () => {
    expect(
      appendTag("Fact. 51837 - CUIT DE PROVEEDOR INEXISTENTE EN BOLETA.pdf", "CUIT DE PROVEEDOR NO REGISTRADO EN DB")
    ).toBe("Fact. 51837 - CUIT DE PROVEEDOR NO REGISTRADO EN DB.pdf");
  });

  it("agrega la etiqueta antes de la extensión", () => {
    expect(appendTag("factura.pdf", "SIN PROVEEDOR")).toBe("factura - SIN PROVEEDOR.pdf");
  });

  it("sin extensión: agrega al final", () => {
    expect(appendTag("factura", "SIN CONSORCIO")).toBe("factura - SIN CONSORCIO");
  });

  it("es idempotente con la misma etiqueta (no apila)", () => {
    expect(appendTag("factura - SIN PROVEEDOR.pdf", "SIN PROVEEDOR")).toBe("factura - SIN PROVEEDOR.pdf");
  });

  it("reemplaza una etiqueta previa distinta (deja solo la actual)", () => {
    expect(appendTag("factura - SIN MONTO.pdf", "SIN PROVEEDOR")).toBe("factura - SIN PROVEEDOR.pdf");
  });

  it("limpia etiquetas apiladas de reprocesos previos", () => {
    expect(appendTag("factura - SIN MONTO - SIN MONTO.pdf", "PROVEEDOR SIN REGISTRAR")).toBe(
      "factura - PROVEEDOR SIN REGISTRAR.pdf"
    );
  });

  it("distingue 'CONSORCIO SIN REGISTRAR' de 'SIN CONSORCIO' sin recortes parciales", () => {
    expect(appendTag("edificio - CONSORCIO SIN REGISTRAR.pdf", "SIN PERÍODO")).toBe("edificio - SIN PERÍODO.pdf");
  });

  it("appendNoAmountTag ahora es idempotente (no duplica SIN MONTO)", () => {
    expect(appendNoAmountTag("x - SIN MONTO.pdf")).toBe("x - SIN MONTO.pdf");
  });
});
