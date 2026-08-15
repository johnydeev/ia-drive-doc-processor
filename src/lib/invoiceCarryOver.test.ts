import { describe, expect, it } from "vitest";
import { applyCarryOverDbMove, recalcRemainingForLateAmount } from "./invoiceCarryOver";

function fakeTx(invoice: { id: string; carriedFromPeriodId: string | null; periodId: string }) {
  const calls: Array<[string, any]> = [];
  const tx: any = {
    expenseObligation: {
      updateMany: async (args: any) => { calls.push(["obligation", args]); return { count: 1 }; },
    },
    invoice: {
      findUnique: async () => invoice,
      update: async (args: any) => { calls.push(["invoice", args]); return { ...invoice, ...args.data }; },
    },
  };
  return { tx, calls, prisma: { $transaction: async (fn: any) => fn(tx) } as any };
}

describe("applyCarryOverDbMove", () => {
  it("marca la obligación de origen CARRIED_OVER conservando el invoiceId", async () => {
    const f = fakeTx({ id: "inv1", carriedFromPeriodId: null, periodId: "ago" });
    await applyCarryOverDbMove(f.prisma, { id: "inv1", periodId: "ago" }, "sep");

    const [, args] = f.calls.find(([k]) => k === "obligation")!;
    expect(args.where).toMatchObject({ invoiceId: "inv1" });
    expect(args.data).toEqual({ status: "CARRIED_OVER" });
    // Clave: NO se desvincula. El mes de origen tiene que seguir mostrando
    // que la boleta llegó y quedó impaga.
    expect(args.data).not.toHaveProperty("invoiceId");
  });

  it("mueve la boleta y registra el período de origen", async () => {
    const f = fakeTx({ id: "inv1", carriedFromPeriodId: null, periodId: "ago" });
    await applyCarryOverDbMove(f.prisma, { id: "inv1", periodId: "ago" }, "sep");

    const [, args] = f.calls.find(([k]) => k === "invoice")!;
    expect(args.data).toMatchObject({ periodId: "sep", carriedFromPeriodId: "ago" });
  });

  it("en un arrastre encadenado conserva el origen original", async () => {
    const f = fakeTx({ id: "inv1", carriedFromPeriodId: "ago", periodId: "sep" });
    await applyCarryOverDbMove(f.prisma, { id: "inv1", periodId: "sep" }, "oct");

    const [, args] = f.calls.find(([k]) => k === "invoice")!;
    expect(args.data).toMatchObject({ periodId: "oct" });
    expect(args.data).not.toHaveProperty("carriedFromPeriodId");
  });
});

describe("recalcRemainingForLateAmount", () => {
  it("sin pagos previos, el saldo pasa a ser el monto vencido", () => {
    expect(recalcRemainingForLateAmount({ amount: 1000, lateAmount: null, remaining: null, next: 1200 }))
      .toEqual({ remaining: 1200, isPaid: false });
  });

  it("con un pago parcial, sube por la diferencia del recargo", () => {
    // Boleta 1000, pagó 400 → saldo 600. Monto vencido 1200 → saldo 800.
    expect(recalcRemainingForLateAmount({ amount: 1000, lateAmount: null, remaining: 600, next: 1200 }))
      .toEqual({ remaining: 800, isPaid: false });
  });

  it("cambiar un monto vencido ya cargado usa el anterior como base", () => {
    expect(recalcRemainingForLateAmount({ amount: 1000, lateAmount: 1200, remaining: 800, next: 1300 }))
      .toEqual({ remaining: 900, isPaid: false });
  });

  it("nunca deja saldo negativo y marca pagada", () => {
    expect(recalcRemainingForLateAmount({ amount: 1000, lateAmount: 1200, remaining: 100, next: 1000 }))
      .toEqual({ remaining: 0, isPaid: true });
  });
});
