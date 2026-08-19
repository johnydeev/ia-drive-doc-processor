import { describe, it, expect } from "vitest";
import { isDuplicateCuit } from "@/lib/duplicateCuit";

const existing = [{ cuit: "30-71741718-2" }, { cuit: null }, { cuit: "20-16654129-9" }];

describe("isDuplicateCuit", () => {
  it("detecta el CUIT ya cargado", () => {
    expect(isDuplicateCuit(existing, "20-16654129-9")).toBe(true);
  });

  it("compara por dígitos: el formato no importa", () => {
    // Sin esto el duplicado entra igual: para Postgres son dos strings distintos,
    // así que el índice único tampoco lo frena.
    expect(isDuplicateCuit(existing, "20166541299")).toBe(true);
    expect(isDuplicateCuit([{ cuit: "20166541299" }], "20-16654129-9")).toBe(true);
  });

  it("deja pasar un CUIT nuevo", () => {
    expect(isDuplicateCuit(existing, "27-16635120-6")).toBe(false);
  });

  it("sin CUIT no hay duplicado (los edificios pueden no tenerlo)", () => {
    expect(isDuplicateCuit(existing, null)).toBe(false);
    expect(isDuplicateCuit(existing, undefined)).toBe(false);
    expect(isDuplicateCuit(existing, "")).toBe(false);
  });

  it("los registros sin CUIT no colisionan entre sí", () => {
    expect(isDuplicateCuit([{ cuit: null }, { cuit: null }], "30-71741718-2")).toBe(false);
  });
});
