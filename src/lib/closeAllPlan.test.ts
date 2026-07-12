import { describe, it, expect } from "vitest";
import { planCloseAll, nextMonthOf, type ActivePeriodLite } from "./closeAllPlan";

function p(id: string, consortiumId: string, year: number, month: number): ActivePeriodLite {
  return { id, consortiumId, year, month };
}

describe("nextMonthOf", () => {
  it("avanza un mes dentro del año", () => {
    expect(nextMonthOf(2026, 6)).toEqual({ year: 2026, month: 7 });
  });
  it("envuelve diciembre a enero del año siguiente", () => {
    expect(nextMonthOf(2026, 12)).toEqual({ year: 2027, month: 1 });
  });
});

describe("planCloseAll", () => {
  it("retorna null si no hay períodos activos", () => {
    expect(planCloseAll([])).toBeNull();
  });

  it("todos en el mismo mes → todos se cierran, 0 salteados, mes siguiente correcto", () => {
    const active = [p("a", "c1", 2026, 6), p("b", "c2", 2026, 6), p("c", "c3", 2026, 6)];
    const plan = planCloseAll(active);
    expect(plan).toEqual({
      majorityYear: 2026,
      majorityMonth: 6,
      nextYear: 2026,
      nextMonth: 7,
      toCloseIds: ["a", "b", "c"],
      toCloseConsortiumIds: ["c1", "c2", "c3"],
      skipCount: 0,
    });
  });

  it("mezcla de meses → cierra el mayoritario y saltea el resto", () => {
    const active = [
      p("a", "c1", 2026, 6),
      p("b", "c2", 2026, 6),
      p("c", "c3", 2026, 7), // minoría → se saltea
    ];
    const plan = planCloseAll(active);
    expect(plan?.majorityMonth).toBe(6);
    expect(plan?.toCloseIds).toEqual(["a", "b"]);
    expect(plan?.toCloseConsortiumIds).toEqual(["c1", "c2"]);
    expect(plan?.skipCount).toBe(1);
  });

  it("mes mayoritario en diciembre → siguiente es enero del año próximo", () => {
    const active = [p("a", "c1", 2026, 12), p("b", "c2", 2026, 12)];
    const plan = planCloseAll(active);
    expect(plan?.nextYear).toBe(2027);
    expect(plan?.nextMonth).toBe(1);
  });

  it("empate → gana el mes que aparece primero", () => {
    const active = [p("a", "c1", 2026, 6), p("b", "c2", 2026, 7)];
    const plan = planCloseAll(active);
    expect(plan?.majorityMonth).toBe(6);
    expect(plan?.toCloseIds).toEqual(["a"]);
    expect(plan?.skipCount).toBe(1);
  });
});
