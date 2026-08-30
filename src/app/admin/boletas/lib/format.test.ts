import { afterEach, describe, expect, it } from "vitest";

import { formatDateOnly, formatDateTime } from "./format";

const AR_TZ = "America/Argentina/Buenos_Aires";
const originalTz = process.env.TZ;

/** Corre `fn` como si el navegador estuviera en Argentina (UTC-3). */
function inArgentina<T>(fn: () => T): T {
  process.env.TZ = AR_TZ;
  return fn();
}

afterEach(() => {
  process.env.TZ = originalTz;
});

describe("formatDateOnly", () => {
  it("muestra el MISMO día que trae la boleta cuando se mira desde Argentina", () => {
    // El vencimiento es un día del calendario: se guarda a medianoche UTC y la API
    // lo serializa así. Formatearlo en hora local de AR (UTC-3) lo correría al 6.
    const result = inArgentina(() => formatDateOnly("2026-07-07T00:00:00.000Z"));

    expect(result).toBe("7/7/26");
  });

  it("da el mismo día sin importar la zona del que mira", () => {
    process.env.TZ = "UTC";
    const enUtc = formatDateOnly("2026-07-07T00:00:00.000Z");
    const enAr = inArgentina(() => formatDateOnly("2026-07-07T00:00:00.000Z"));

    expect(enAr).toBe(enUtc);
  });

  it("no corre el día en un vencimiento de primero de mes", () => {
    // El caso más visible del bug: 01/09 se mostraba como 31/08, o sea otro mes.
    const result = inArgentina(() => formatDateOnly("2026-09-01T00:00:00.000Z"));

    expect(result).toBe("1/9/26");
  });

  it("devuelve un guion cuando la boleta no tiene vencimiento", () => {
    expect(formatDateOnly(null)).toBe("—");
  });

  it("devuelve un guion cuando la fecha es inválida", () => {
    expect(formatDateOnly("no es una fecha")).toBe("—");
  });
});

describe("formatDateTime", () => {
  it("muestra los instantes reales en la zona del que mira", () => {
    // `createdAt` SÍ es un momento en el tiempo: en AR las 12:00 UTC son las 9:00.
    const result = inArgentina(() => formatDateTime("2026-07-07T12:00:00.000Z"));

    expect(result).toContain("7/7/26");
    expect(result).toContain("9:00");
  });

  it("devuelve un guion cuando la fecha es inválida", () => {
    expect(formatDateTime("no es una fecha")).toBe("—");
  });
});
