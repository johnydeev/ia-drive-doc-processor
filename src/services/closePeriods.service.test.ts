import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { executeCloseAll } from "./closePeriods.service";

type Call = { op: string; args: unknown };

/**
 * Fake prisma que registra las llamadas relevantes. `period.findMany` discrimina
 * entre la búsqueda de ACTIVE (antes de la txn) y la de períodos nuevos (en el
 * ajuste de obligaciones) por el `where`.
 */
function makeFakePrisma(active: Array<{ id: string; consortiumId: string; year: number; month: number }>) {
  const calls: Call[] = [];
  const periodApi = {
    findMany: async (args: { where?: { status?: string } }) => {
      calls.push({ op: "period.findMany", args });
      if (args?.where?.status === "ACTIVE") return active;
      return []; // búsqueda de períodos nuevos (obligaciones)
    },
    updateMany: async (args: unknown) => {
      calls.push({ op: "period.updateMany", args });
      return { count: active.length };
    },
    createMany: async (args: unknown) => {
      calls.push({ op: "period.createMany", args });
      return { count: active.length };
    },
    count: async (args: unknown) => {
      calls.push({ op: "period.count", args });
      return active.length;
    },
  };

  const prisma = {
    period: periodApi,
    expenseObligation: {
      findMany: async () => [],
      updateMany: async () => ({ count: 0 }),
      createMany: async () => ({ count: 0 }),
    },
    fixedExpense: { findMany: async () => [] },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ period: periodApi }),
  } as unknown as PrismaClient;

  return { prisma, calls };
}

describe("executeCloseAll", () => {
  it("sin períodos activos → no-op", async () => {
    const { prisma } = makeFakePrisma([]);
    const res = await executeCloseAll("cli1", prisma);
    expect(res).toEqual({ closed: 0, created: 0, skipped: 0, warnings: [] });
  });

  it("cierra en bloque el mes mayoritario y devuelve contadores", async () => {
    const active = [
      { id: "p1", consortiumId: "c1", year: 2026, month: 6 },
      { id: "p2", consortiumId: "c2", year: 2026, month: 6 },
      { id: "p3", consortiumId: "c3", year: 2026, month: 7 }, // minoría → salteado
    ];
    const { prisma, calls } = makeFakePrisma(active);

    const res = await executeCloseAll("cli1", prisma);

    expect(res.closed).toBe(3); // count del fake (updateMany devuelve active.length)
    expect(res.skipped).toBe(1); // el de julio
    expect(res.warnings).toEqual([]);

    // Idempotencia crítica: updateMany filtra por status ACTIVE.
    const upd = calls.find((c) => c.op === "period.updateMany");
    expect((upd?.args as { where: { status: string } }).where.status).toBe("ACTIVE");
    // Idempotencia crítica: createMany usa skipDuplicates.
    const crt = calls.find((c) => c.op === "period.createMany");
    expect((crt?.args as { skipDuplicates: boolean }).skipDuplicates).toBe(true);
    // Solo se crean los del mes mayoritario (2 consorcios, no 3).
    expect((crt?.args as { data: unknown[] }).data).toHaveLength(2);
  });
});
