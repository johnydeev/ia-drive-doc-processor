import { describe, it, expect } from "vitest";
import { generateObligationsForPeriod } from "./obligation.service";

/** Fake prisma en memoria, solo con lo que usa generateObligationsForPeriod. */
function makeFakePrisma(opts: {
  period: { id: string; consortiumId: string; clientId: string };
  fixedExpenses: Array<{ id: string; providerId: string | null; lspServiceId: string | null }>;
  invoices: Array<{ id: string; providerId: string | null; lspServiceId: string | null }>;
  existingObligations?: Array<{ fixedExpenseId: string }>;
}) {
  const created: any[] = [];
  const updated: any[] = [];
  return {
    created,
    updated,
    client: {
      period: {
        findUnique: async () => opts.period,
      },
      fixedExpense: {
        findMany: async () => opts.fixedExpenses,
      },
      expenseObligation: {
        findMany: async () => (opts.existingObligations ?? []).map((o) => ({ fixedExpenseId: o.fixedExpenseId })),
        create: async ({ data }: any) => { created.push(data); return { id: `ob-${created.length}`, ...data }; },
        update: async ({ where, data }: any) => { updated.push({ where, data }); return { ...where, ...data }; },
      },
      invoice: {
        findMany: async () => opts.invoices,
      },
    } as any,
  };
}

describe("generateObligationsForPeriod", () => {
  it("crea una obligación PENDING por cada gasto fijo activo, idempotente", async () => {
    const fake = makeFakePrisma({
      period: { id: "per1", consortiumId: "c1", clientId: "cl1" },
      fixedExpenses: [
        { id: "fx1", providerId: "p1", lspServiceId: null },
        { id: "fx2", providerId: null, lspServiceId: "l1" },
      ],
      invoices: [],
      existingObligations: [{ fixedExpenseId: "fx1" }], // fx1 ya existe → no se recrea
    });
    const res = await generateObligationsForPeriod("per1", fake.client);
    expect(res.created).toBe(1); // solo fx2
    expect(fake.created[0]).toMatchObject({ fixedExpenseId: "fx2", status: "PENDING", periodId: "per1" });
  });

  it("vincula retroactivamente una boleta ya presente que matchea", async () => {
    const fake = makeFakePrisma({
      period: { id: "per1", consortiumId: "c1", clientId: "cl1" },
      fixedExpenses: [{ id: "fx2", providerId: null, lspServiceId: "l1" }],
      invoices: [{ id: "inv9", providerId: "pX", lspServiceId: "l1" }],
    });
    const res = await generateObligationsForPeriod("per1", fake.client);
    expect(res.created).toBe(1);
    expect(res.linked).toBe(1);
    expect(fake.updated[0].data).toMatchObject({ status: "RECEIVED", invoiceId: "inv9" });
  });
});
