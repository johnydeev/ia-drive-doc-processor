import { describe, expect, it } from "vitest";
import { normalizeLspClientNumber, planCuitEntity, planKeyedEntity } from "./directorySyncPlan";

const CAMPOS = ["cuit", "matchNames"] as const;

function existente(over: Partial<{ id: string; canonicalName: string; cuit: string | null; matchNames: string | null }> = {}) {
  return { id: "c1", canonicalName: "FRIAS 320", cuit: "30-11111111-1", matchNames: null, ...over };
}

describe("planCuitEntity", () => {
  it("sin cambios no produce ningún update", () => {
    const plan = planCuitEntity({
      sheetRows: [{ canonicalName: "FRIAS 320", cuit: "30-11111111-1", matchNames: null }],
      existing: [existente()],
      compareFields: CAMPOS,
    });
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toEqual([]);
    expect(plan.orphans).toEqual([]);
    expect(plan.renames).toEqual([]);
  });

  it("compara el CUIT por dígitos, no por formato", () => {
    const plan = planCuitEntity({
      sheetRows: [{ canonicalName: "FRIAS 320", cuit: "30111111111", matchNames: null }],
      existing: [existente()],
      compareFields: CAMPOS,
    });
    expect(plan.updates).toEqual([]);
  });

  // El update lleva SIEMPRE el valor final de todas las columnas comparables, no
  // sólo el de la que cambió: se escriben todas juntas en un único UPDATE, y una
  // columna ausente se escribiría como null.
  it("un campo cambiado produce un update con el valor final de todos los campos", () => {
    const plan = planCuitEntity({
      sheetRows: [{ canonicalName: "FRIAS 320", cuit: "30-11111111-1", matchNames: "FRIAS 324" }],
      existing: [existente()],
      compareFields: CAMPOS,
    });
    expect(plan.updates).toEqual([
      { id: "c1", values: { cuit: "30-11111111-1", matchNames: "FRIAS 324" } },
    ]);
  });

  // Blindaje: dos filas del mismo lote cambian columnas distintas. Si el update de
  // cada una no trajera TODAS las columnas, el UPDATE conjunto escribiría null
  // sobre el dato bueno de la otra.
  it("en un lote mixto, cada update conserva el valor de la columna que no cambió", () => {
    const plan = planCuitEntity({
      sheetRows: [
        { canonicalName: "A", cuit: "30-22222222-2", matchNames: "ALIAS A" },
        { canonicalName: "B", cuit: "30-33333333-3", matchNames: "ALIAS B NUEVO" },
      ],
      existing: [
        { id: "a1", canonicalName: "A", cuit: "30-99999999-9", matchNames: "ALIAS A" },
        { id: "b1", canonicalName: "B", cuit: "30-33333333-3", matchNames: "ALIAS B" },
      ],
      compareFields: CAMPOS,
    });
    expect(plan.updates).toEqual([
      { id: "a1", values: { cuit: "30-22222222-2", matchNames: "ALIAS A" } },
      { id: "b1", values: { cuit: "30-33333333-3", matchNames: "ALIAS B NUEVO" } },
    ]);
  });

  it("una fila que no existe se crea", () => {
    const plan = planCuitEntity({
      sheetRows: [{ canonicalName: "NUEVA 100", cuit: "30-22222222-2", matchNames: null }],
      existing: [existente()],
      compareFields: CAMPOS,
    });
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0].canonicalName).toBe("NUEVA 100");
  });

  it("lo que está en la base y no en la hoja se reporta, nunca se borra", () => {
    const plan = planCuitEntity({
      sheetRows: [],
      existing: [existente()],
      compareFields: CAMPOS,
    });
    expect(plan.orphans).toEqual([{ id: "c1", name: "FRIAS 320" }]);
    expect(plan).not.toHaveProperty("deletes");
  });

  it("nombre nuevo con el CUIT de uno existente ausente de la hoja = renombre, sin alta", () => {
    const plan = planCuitEntity({
      sheetRows: [{ canonicalName: "FRIAS 324", cuit: "30-11111111-1", matchNames: null }],
      existing: [existente()],
      compareFields: CAMPOS,
    });
    expect(plan.renames).toEqual([
      { id: "c1", from: "FRIAS 320", to: "FRIAS 324", cuit: "30-11111111-1" },
    ]);
    expect(plan.creates).toEqual([]);
    expect(plan.orphans).toEqual([]);
  });

  it("guarda 1: sin CUIT no hay renombre, es un alta", () => {
    const plan = planCuitEntity({
      sheetRows: [{ canonicalName: "FRIAS 324", cuit: null, matchNames: null }],
      existing: [existente()],
      compareFields: CAMPOS,
    });
    expect(plan.renames).toEqual([]);
    expect(plan.creates).toHaveLength(1);
  });

  it("guarda 2: CUIT que matchea a dos es ambiguo, no crea ni renombra", () => {
    const plan = planCuitEntity({
      sheetRows: [{ canonicalName: "FRIAS 324", cuit: "30-11111111-1", matchNames: null }],
      existing: [existente(), existente({ id: "c2", canonicalName: "OTRO 500" })],
      compareFields: CAMPOS,
    });
    expect(plan.renames).toEqual([]);
    expect(plan.creates).toEqual([]);
    expect(plan.ambiguous).toEqual(["FRIAS 324"]);
  });

  it("guarda 3: si el CUIT apunta a alguien que la hoja ya nombra, es un alta", () => {
    const plan = planCuitEntity({
      sheetRows: [
        { canonicalName: "FRIAS 320", cuit: "30-11111111-1", matchNames: null },
        { canonicalName: "FRIAS 324", cuit: "30-11111111-1", matchNames: null },
      ],
      existing: [existente()],
      compareFields: CAMPOS,
    });
    expect(plan.renames).toEqual([]);
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0].canonicalName).toBe("FRIAS 324");
  });

  it("el renombrado no aparece además como sobrante", () => {
    const plan = planCuitEntity({
      sheetRows: [{ canonicalName: "FRIAS 324", cuit: "30-11111111-1", matchNames: null }],
      existing: [existente(), existente({ id: "c9", canonicalName: "VIEJO 1", cuit: "30-99999999-9" })],
      compareFields: CAMPOS,
    });
    expect(plan.orphans).toEqual([{ id: "c9", name: "VIEJO 1" }]);
  });

  it("compara los campos extra de proveedor", () => {
    const plan = planCuitEntity({
      sheetRows: [{ canonicalName: "TIGRE", cuit: null, matchNames: null, paymentAlias: "tigre.pago", providerType: "PROVEEDOR" }],
      existing: [{ id: "p1", canonicalName: "TIGRE", cuit: null, matchNames: null, paymentAlias: null, providerType: "PROVEEDOR" }],
      compareFields: ["cuit", "matchNames", "paymentAlias", "providerType"] as const,
    });
    expect(plan.updates).toEqual([
      { id: "p1", values: { cuit: null, matchNames: null, paymentAlias: "tigre.pago", providerType: "PROVEEDOR" } },
    ]);
  });
});

describe("planKeyedEntity", () => {
  it("sin cambios no produce updates (rubros)", () => {
    const plan = planKeyedEntity({
      sheetRows: [{ name: "LIMPIEZA", description: null }],
      existing: [{ id: "r1", name: "LIMPIEZA", description: null }],
      keyOf: (r: { name: string }) => r.name,
      compareFields: ["description"],
    });
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toEqual([]);
  });

  it("cambia la descripción y conserva el id", () => {
    const plan = planKeyedEntity({
      sheetRows: [{ name: "LIMPIEZA", description: "mensual" as string | null }],
      existing: [{ id: "r1", name: "LIMPIEZA", description: null as string | null }],
      keyOf: (r: { name: string }) => r.name,
      compareFields: ["description"],
    });
    expect(plan.updates).toEqual([{ id: "r1", values: { description: "mensual" } }]);
  });

  it("lo que falta en la hoja se reporta, no se borra", () => {
    const plan = planKeyedEntity({
      sheetRows: [],
      existing: [{ id: "r1", name: "LIMPIEZA", description: null }],
      keyOf: (r: { name: string }) => r.name,
      compareFields: ["description"],
    });
    expect(plan.orphans).toEqual([{ id: "r1", name: "LIMPIEZA" }]);
  });

  // REGRESIÓN del bug que desvinculó 70 boletas: el servicio que ya existe
  // NO se recrea, así que su id sobrevive y las boletas lo siguen apuntando.
  it("un LspService que no cambió no se crea de nuevo: conserva su id", () => {
    const plan = planKeyedEntity({
      sheetRows: [{ consortiumId: "c1", providerName: "EDESUR", clientNumber: "1061158", description: null }],
      existing: [{ id: "l1", consortiumId: "c1", providerName: "EDESUR", clientNumber: "1061158", description: null }],
      keyOf: (r: { consortiumId: string; providerName: string; clientNumber: string }) =>
        `${r.consortiumId}|${r.providerName}|${r.clientNumber}`,
      compareFields: ["description"],
    });
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.orphans).toEqual([]);
  });
});

describe("normalizeLspClientNumber", () => {
  it("saca espacios y ceros a la izquierda", () => {
    expect(normalizeLspClientNumber(" 00 1061158 ")).toBe("1061158");
  });

  it("si queda vacío devuelve el original", () => {
    expect(normalizeLspClientNumber("000")).toBe("000");
  });
});
