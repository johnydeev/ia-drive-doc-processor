import { describe, expect, it } from "vitest";
import { validateLabels } from "./labelAssignment.service";

function fakePrisma(rubroIds: string[], coeficienteIds: string[]) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      consortiumRubro: { findMany: async () => { calls.push("rubro"); return rubroIds.map((rubroId) => ({ rubroId })); } },
      consortiumCoeficiente: { findMany: async () => { calls.push("coef"); return coeficienteIds.map((coeficienteId) => ({ coeficienteId })); } },
    } as any,
  };
}

describe("validateLabels", () => {
  it("acepta lo que el edificio tiene asignado", async () => {
    const f = fakePrisma(["r3"], ["cA"]);
    expect(await validateLabels(f.client, "c1", { rubroId: "r3", coeficienteId: "cA" })).toBeNull();
  });

  it("rechaza un rubro ajeno al edificio con el mensaje de checkAssignable", async () => {
    const f = fakePrisma(["r3"], ["cA"]);
    expect(await validateLabels(f.client, "c1", { rubroId: "r9" })).toBe("Ese rubro no está asignado a este edificio");
  });

  it("rechaza un coeficiente ajeno", async () => {
    const f = fakePrisma([], ["cA"]);
    expect(await validateLabels(f.client, "c1", { coeficienteId: "cZ" })).toBe("Ese coeficiente no está asignado a este edificio");
  });

  it("sólo consulta lo que vino: sin coeficiente no toca ConsortiumCoeficiente", async () => {
    const f = fakePrisma(["r3"], []);
    await validateLabels(f.client, "c1", { rubroId: null });
    expect(f.calls).toEqual(["rubro"]);
  });
});
