import { describe, it, expect } from "vitest";
import {
  isPreviousMonth, majorityMonth, nextMonth, parseMonthParam,
  periodLabel, previousMonth, sameMonth,
} from "@/lib/periodMonth";

describe("navegación de meses", () => {
  it("avanza y retrocede envolviendo el año", () => {
    expect(nextMonth({ year: 2026, month: 12 })).toEqual({ year: 2027, month: 1 });
    expect(previousMonth({ year: 2026, month: 1 })).toEqual({ year: 2025, month: 12 });
  });

  it("reconoce el mes inmediatamente anterior, incluso cruzando diciembre", () => {
    expect(isPreviousMonth({ year: 2026, month: 7 }, { year: 2026, month: 8 })).toBe(true);
    expect(isPreviousMonth({ year: 2025, month: 12 }, { year: 2026, month: 1 })).toBe(true);
    expect(isPreviousMonth({ year: 2026, month: 6 }, { year: 2026, month: 8 })).toBe(false);
  });

  it("compara meses", () => {
    expect(sameMonth({ year: 2026, month: 8 }, { year: 2026, month: 8 })).toBe(true);
    expect(sameMonth({ year: 2026, month: 8 }, { year: 2025, month: 8 })).toBe(false);
  });

  it("etiqueta en castellano", () => {
    expect(periodLabel(2026, 8)).toBe("agosto 2026");
  });
});

describe("parseMonthParam", () => {
  it("acepta un mes válido", () => {
    expect(parseMonthParam("8", "2026")).toEqual({ year: 2026, month: 8 });
  });

  it("devuelve null si falta alguno", () => {
    expect(parseMonthParam(null, "2026")).toBeNull();
    expect(parseMonthParam("8", null)).toBeNull();
  });

  it("rechaza valores fuera de rango o no numéricos", () => {
    // Sin esto, un ?month=13 llegaría a la consulta.
    expect(parseMonthParam("13", "2026")).toBeNull();
    expect(parseMonthParam("0", "2026")).toBeNull();
    expect(parseMonthParam("agosto", "2026")).toBeNull();
    expect(parseMonthParam("8", "1999")).toBeNull();
    expect(parseMonthParam("8.5", "2026")).toBeNull();
  });
});

describe("majorityMonth", () => {
  it("elige el mes más repetido", () => {
    const periods = [
      { year: 2026, month: 8 }, { year: 2026, month: 8 }, { year: 2026, month: 8 },
      { year: 2026, month: 9 },
    ];

    expect(majorityMonth(periods)).toEqual({ year: 2026, month: 8 });
  });

  it("ante empate gana el más reciente", () => {
    // Los edificios adelantados no deberían arrastrar la vista hacia atrás.
    const periods = [{ year: 2026, month: 8 }, { year: 2026, month: 9 }];

    expect(majorityMonth(periods)).toEqual({ year: 2026, month: 9 });
  });

  it("sin períodos devuelve null", () => {
    expect(majorityMonth([])).toBeNull();
  });
});
