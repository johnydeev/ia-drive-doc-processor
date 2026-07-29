import { describe, it, expect } from "vitest";
import { correctVatContainedAmount } from "@/lib/vatContainedAmountGuard";

// Texto REAL extraído con pdf-parse de la boleta 0003-00161074 (RANKO S.R.L. →
// BARTOLOME MITRE 1225). Es el caso que originó el fix: la IA guardó 62601.88
// (el IVA contenido) en vez de 360706.09 (el total). Nótese que los rótulos
// "IVA Contenido: $" y "Otros Impuestos..." quedan VACÍOS y sus valores caen
// 16 líneas más abajo — así es como pdf-parse lineariza este PDF.
const RANKO_TEXT = [
  "REMITO:",
  "Vto. de CAE CAE Nº",
  "$",
  "Régimen de Transparencia Fiscal al Consumidor (Ley 27.743)",
  "IVA Contenido: $",
  "Otros Impuestos Nacionales Indirectos: $",
  "*1812853*",
  "3067916331706000386294969939102202608011",
  "FACTURA",
  "0003-00161074BUENOS AIRES22/07/2026",
  "CONSORCIO BARTOLOME MITRE 1225 (COD.Nº 12879) V.3",
  "ADM. MORINIGO NATALIA (ADMIN Nº 6406)",
  "BARTOLOME MITRE 1225 C.A.B.A",
  "1131573500 RSN1000CONSUMIDOR FINAL 30-69377848-0",
  "A CONVENIR",
  "ESTA EMPRESA POSEE SELLO DE CALIDAD IRAM",
  "El control periódico es necesario para garantizar la seguridad de los equipos extintores.",
  "1.00 SERVICIO DE MANTENIMIENTO ANUAL DE LOS EXTINTORES 360706.09 360706.09",
  "DEL EDIFICIO",
  "Cuota 1 de 3",
  "62601.88",
  "0.00 360706.09",
  "86294969939102 01/08/2026",
  "ORIGINAL",
  "Cód. nº 06",
].join("\n");

describe("correctVatContainedAmount — caso real RANKO 0003-00161074", () => {
  it("corrige el IVA contenido (62601.88) al total real (360706.09)", () => {
    const r = correctVatContainedAmount(62601.88, RANKO_TEXT);
    expect(r.corrected).toBe(true);
    expect(r.amount).toBe(360706.09);
    expect(r.original).toBe(62601.88);
    expect(r.rate).toBe(0.21);
  });

  it("es idempotente: aplicado sobre el monto ya corregido, no vuelve a tocar", () => {
    const once = correctVatContainedAmount(62601.88, RANKO_TEXT);
    const twice = correctVatContainedAmount(once.amount, RANKO_TEXT);
    expect(twice.corrected).toBe(false);
    expect(twice.amount).toBe(360706.09);
  });

  it("no toca el monto si la IA ya había extraído el total correcto", () => {
    const r = correctVatContainedAmount(360706.09, RANKO_TEXT);
    expect(r.corrected).toBe(false);
    expect(r.amount).toBe(360706.09);
  });
});

describe("correctVatContainedAmount — las 4 condiciones", () => {
  it("condición 1: sin marcador de Ley 27.743 no corrige, aunque la aritmética cierre", () => {
    const sinMarcador = "FACTURA\nSERVICIO 360706.09\n62601.88\n360706.09";
    const r = correctVatContainedAmount(62601.88, sinMarcador);
    expect(r.corrected).toBe(false);
    expect(r.amount).toBe(62601.88);
  });

  it("condición 2: con marcador pero sin identidad aritmética no corrige", () => {
    const texto = "IVA Contenido: $\nFACTURA\n50000.00\n360706.09";
    const r = correctVatContainedAmount(50000, texto);
    expect(r.corrected).toBe(false);
    expect(r.amount).toBe(50000);
  });

  it("condición 4: si el monto de la IA ya es la cifra máxima no corrige", () => {
    const texto = "IVA Contenido: $\n100.00\n500.00";
    const r = correctVatContainedAmount(500, texto);
    expect(r.corrected).toBe(false);
  });

  it("no corrige con amount null", () => {
    const r = correctVatContainedAmount(null, RANKO_TEXT);
    expect(r.corrected).toBe(false);
    expect(r.amount).toBeNull();
  });

  it("no corrige con amount 0 (boletas LSP de $0 son válidas)", () => {
    const r = correctVatContainedAmount(0, RANKO_TEXT);
    expect(r.corrected).toBe(false);
    expect(r.amount).toBe(0);
  });

  it("no corrige si el texto no tiene cifras monetarias", () => {
    const r = correctVatContainedAmount(100, "IVA Contenido: $\nsin cifras acá");
    expect(r.corrected).toBe(false);
  });
});

describe("correctVatContainedAmount — tasas y formatos", () => {
  it("detecta IVA al 10,5%", () => {
    // total 200000.00 → IVA contenido 10,5% = 200000 * 0.105/1.105 = 19004.52
    const texto = "Régimen de Transparencia Fiscal al Consumidor (Ley 27.743)\n19004.52\n200000.00";
    const r = correctVatContainedAmount(19004.52, texto);
    expect(r.corrected).toBe(true);
    expect(r.amount).toBe(200000);
    expect(r.rate).toBe(0.105);
  });

  it("funciona con montos en formato es-AR (360.706,09 / 62.601,88)", () => {
    const texto = "IVA Contenido: $ \nOtros Impuestos Nacionales Indirectos: $\n62.601,88\n360.706,09";
    const r = correctVatContainedAmount(62601.88, texto);
    expect(r.corrected).toBe(true);
    expect(r.amount).toBe(360706.09);
  });

  it("no confunde el CAE ni el código de barras con cifras monetarias", () => {
    // Sin decimales no es un importe: el máximo debe seguir siendo 360706.09.
    const texto = [
      "IVA Contenido: $",
      "3067916331706000386294969939102202608011",
      "86294969939102",
      "62601.88",
      "360706.09",
    ].join("\n");
    const r = correctVatContainedAmount(62601.88, texto);
    expect(r.corrected).toBe(true);
    expect(r.amount).toBe(360706.09);
  });
});
