import { describe, it, expect } from "vitest";
import { parseAmountInput, formatAmount, formatPeriod, toInputDate, todayInputDate } from "./format";

describe("parseAmountInput", () => {
  it("es-AR miles+decimales: '97.500,40' → 97500.4", () => {
    expect(parseAmountInput("97.500,40")).toBe(97500.4);
  });
  it("en-US con coma de miles: '97,500.40' → 97500.4", () => {
    expect(parseAmountInput("97,500.40")).toBe(97500.4);
  });
  it("punto decimal simple: '97500.40' → 97500.4", () => {
    expect(parseAmountInput("97500.40")).toBe(97500.4);
  });
  it("coma decimal simple: '97500,40' → 97500.4", () => {
    expect(parseAmountInput("97500,40")).toBe(97500.4);
  });
  it("con símbolo y espacios: '$ 118.000,00' → 118000", () => {
    expect(parseAmountInput("$ 118.000,00")).toBe(118000);
  });
  it("vacío → NaN", () => {
    expect(Number.isNaN(parseAmountInput(""))).toBe(true);
  });
});

describe("formatAmount", () => {
  it("null → '—'", () => expect(formatAmount(null)).toBe("—"));
  it("formatea es-AR con separador de miles y 2 decimales", () => {
    // Assert resiliente al carácter de espacio/símbolo que use ICU
    expect(formatAmount(118000)).toContain("118.000,00");
  });
});

describe("formatPeriod", () => {
  it("null → 'Sin período activo'", () => expect(formatPeriod(null)).toBe("Sin período activo"));
  it("mes/año en español", () =>
    expect(formatPeriod({ id: "p1", year: 2026, month: 7, status: "ACTIVE" })).toBe("Julio 2026"));
});

describe("toInputDate / todayInputDate", () => {
  it("toInputDate recorta a YYYY-MM-DD", () =>
    expect(toInputDate("2026-07-16T00:00:00.000Z")).toBe("2026-07-16"));
  it("toInputDate null → ''", () => expect(toInputDate(null)).toBe(""));
  it("todayInputDate devuelve formato YYYY-MM-DD", () =>
    expect(todayInputDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/));
});
