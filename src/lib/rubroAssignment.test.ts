import { describe, expect, it } from "vitest";
import { checkAssignable, excludeAssigned, orphanedBy } from "./rubroAssignment";

describe("checkAssignable", () => {
  it("acepta un id que el edificio tiene asignado", () => {
    expect(checkAssignable("r3", ["r1", "r3"], "rubro")).toEqual({ ok: true });
  });

  it("acepta null: desasignar siempre se puede", () => {
    expect(checkAssignable(null, ["r1"], "rubro")).toEqual({ ok: true });
    expect(checkAssignable(null, [], "coeficiente")).toEqual({ ok: true });
  });

  it("rechaza un id que el edificio no tiene, y lo dice", () => {
    expect(checkAssignable("r9", ["r1", "r3"], "rubro")).toEqual({
      ok: false,
      error: "Ese rubro no está asignado a este edificio",
    });
  });

  it("nombra al coeficiente en su propio mensaje", () => {
    expect(checkAssignable("c9", [], "coeficiente")).toEqual({
      ok: false,
      error: "Ese coeficiente no está asignado a este edificio",
    });
  });

  // Un edificio sin nada asignado es el estado inicial de los 47: hasta que el
  // administrador le marque sus rubros, no se le puede etiquetar ningún gasto fijo.
  it("un edificio sin nada asignado rechaza cualquier id", () => {
    expect(checkAssignable("r1", [], "rubro").ok).toBe(false);
  });
});

/**
 * `notIn: []` en Prisma matchea CERO filas, no todas (verificado contra la base el
 * 2026-09-24). Sin estos helpers, destildar TODAS las casillas de un edificio no
 * borraba ninguna asignación ni dejaba huérfano a ningún gasto fijo: el guardado
 * decía "Guardado." y no hacía nada.
 */
describe("excludeAssigned", () => {
  it("con ids, filtra los que no están en la lista", () => {
    expect(excludeAssigned(["r1", "r2"])).toEqual({ notIn: ["r1", "r2"] });
  });

  it("sin ids, no pone filtro: alcanza a TODAS las filas", () => {
    expect(excludeAssigned([])).toBeUndefined();
  });
});

describe("orphanedBy", () => {
  it("con ids, busca los etiquetados que quedaron fuera", () => {
    expect(orphanedBy(["r1"])).toEqual({ not: null, notIn: ["r1"] });
  });

  it("sin ids, todos los etiquetados quedan huérfanos", () => {
    expect(orphanedBy([])).toEqual({ not: null });
  });
});
