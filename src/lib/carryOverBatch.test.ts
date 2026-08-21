import { describe, it, expect } from "vitest";
import {
  CARRY_OVER_BATCH_SIZE, splitIntoBatches, validateCarryOverBatch,
} from "@/lib/carryOverBatch";

describe("validateCarryOverBatch", () => {
  it("acepta una tanda válida", () => {
    expect(validateCarryOverBatch(["a", "b"])).toEqual({ ok: true, invoiceIds: ["a", "b"] });
  });

  it("deduplica", () => {
    expect(validateCarryOverBatch(["a", "a"])).toEqual({ ok: true, invoiceIds: ["a"] });
  });

  it("rechaza una tanda vacía", () => {
    expect(validateCarryOverBatch([])).toEqual({ ok: false, error: "No se recibió ninguna boleta" });
    expect(validateCarryOverBatch(null)).toEqual({ ok: false, error: "No se recibió ninguna boleta" });
  });

  it("rechaza más del tope: no se confía en el navegador", () => {
    const many = Array.from({ length: CARRY_OVER_BATCH_SIZE + 1 }, (_, i) => `id-${i}`);

    expect(validateCarryOverBatch(many)).toEqual({
      ok: false,
      error: `Máximo ${CARRY_OVER_BATCH_SIZE} boletas por tanda`,
    });
  });

  it("ignora lo que no sea string", () => {
    expect(validateCarryOverBatch(["a", 3, null, "b"])).toEqual({ ok: true, invoiceIds: ["a", "b"] });
  });
});

describe("splitIntoBatches", () => {
  it("parte en tandas del tamaño permitido, en orden", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `i${i}`);

    const batches = splitIntoBatches(ids);

    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(CARRY_OVER_BATCH_SIZE);
    expect(batches[2]).toEqual(["i10", "i11"]);
  });

  it("sin boletas no hay tandas", () => {
    expect(splitIntoBatches([])).toEqual([]);
  });
});
