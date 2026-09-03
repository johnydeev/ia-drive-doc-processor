import { describe, expect, it } from "vitest";
import { validateLsdRoster } from "./lsdValidation";

const empleados = [
  { cuil: "27-18116846-9", apellidoNombre: "BRITEZ", sueldoNeto: 100 },
  { cuil: "20-24883768-4", apellidoNombre: "CRUZ", sueldoNeto: 200 },
];
const directorio = [
  { id: "p1", cuit: "27-18116846-9" },
  { id: "p2", cuit: "20-24883768-4" },
];

describe("validateLsdRoster", () => {
  it("OK cuando todos están de alta y cubren los gastos fijos", () => {
    const r = validateLsdRoster(empleados, directorio, ["p1", "p2"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.matched.map((m) => m.providerId)).toEqual(["p1", "p2"]);
  });

  it("OK si el edificio todavía no tiene gastos fijos cargados", () => {
    // No hay padrón contra el cual comparar: la primera condición ya alcanza.
    const r = validateLsdRoster(empleados, directorio, []);
    expect(r.ok).toBe(true);
  });

  it("falla si un CUIL no está en el directorio (el caso del suplente)", () => {
    const r = validateLsdRoster(
      [...empleados, { cuil: "20-95678503-1", apellidoNombre: "SUPLENTE", sueldoNeto: 50 }],
      directorio,
      ["p1", "p2"]
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reasonCategory).toBe("lsd_empleado_no_registrado");
      expect(r.detail).toContain("20-95678503-1");
    }
  });

  it("falla si queda un gasto fijo sin cubrir (la IA se salteó a alguien)", () => {
    const r = validateLsdRoster(empleados, directorio, ["p1", "p2", "p3"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasonCategory).toBe("lsd_empleado_faltante");
  });

  it("compara CUIL por dígitos, no por formato", () => {
    const r = validateLsdRoster(
      [{ cuil: "27181168469", apellidoNombre: "BRITEZ", sueldoNeto: 100 }],
      [{ id: "p1", cuit: "27-18116846-9" }],
      ["p1"]
    );
    expect(r.ok).toBe(true);
  });

  it("falla si el libro no trae ningún empleado", () => {
    const r = validateLsdRoster([], directorio, ["p1"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasonCategory).toBe("lsd_sin_empleados");
  });

  it("ignora proveedores sin CUIT cargado", () => {
    const r = validateLsdRoster(
      [{ cuil: "27-18116846-9", apellidoNombre: "BRITEZ", sueldoNeto: 100 }],
      [{ id: "sin-cuit", cuit: null }, { id: "p1", cuit: "27-18116846-9" }],
      ["p1"]
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.matched[0].providerId).toBe("p1");
  });

  it("un empleado de más NO alcanza para cubrir a otro que falta", () => {
    // p2 está en el padrón pero no en el libro; el libro trae a p1 dos veces
    // no puede pasar (se deduplica antes), así que basta con que falte p2.
    const r = validateLsdRoster(
      [{ cuil: "27-18116846-9", apellidoNombre: "BRITEZ", sueldoNeto: 100 }],
      directorio,
      ["p1", "p2"]
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasonCategory).toBe("lsd_empleado_faltante");
  });
});
