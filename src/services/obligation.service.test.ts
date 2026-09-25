import { describe, it, expect } from "vitest";
import {
  generateObligationsForPeriod,
  linkInvoiceToObligation,
  syncObligationsForClient,
} from "./obligation.service";

/** Fake prisma en memoria, solo con lo que usa generateObligationsForPeriod. */
function makeFakePrisma(opts: {
  period: { id: string; consortiumId: string; clientId: string };
  fixedExpenses: Array<{ id: string; providerId: string | null; lspServiceId: string | null; kind?: "FACTURA" | "RETENCION" }>;
  invoices: Array<{ id: string; providerId: string | null; lspServiceId: string | null; docKind?: "FACTURA" | "RETENCION" }>;
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

/** Fake prisma para syncObligationsForClient: set-based, sin `create` de a uno. */
function makeFakeSyncPrisma(opts: {
  periods: Array<{ id: string; consortiumId: string }>;
  fixedExpenses: Array<{
    id: string; consortiumId: string; providerId: string | null; lspServiceId: string | null;
    rubroId?: string | null; coeficienteId?: string | null;
  }>;
  existing?: Array<{ periodId: string; fixedExpenseId: string; invoiceId: string | null }>;
  invoices?: Array<{
    id: string; periodId: string; providerId: string | null; lspServiceId: string | null;
    /** Presente si la boleta vino arrastrada de un período anterior. */
    carriedFromPeriodId?: string | null;
  }>;
  /** Obligaciones que la 2ª lectura devuelve como recién creadas (sin boleta). */
  fresh?: Array<{ id: string; periodId: string; fixedExpenseId: string }>;
}) {
  const createdMany: any[] = [];
  const updated: any[] = [];
  const invoiceUpdates: any[] = [];
  return {
    createdMany,
    updated,
    invoiceUpdates,
    client: {
      period: { findMany: async () => opts.periods },
      fixedExpense: { findMany: async () => opts.fixedExpenses },
      expenseObligation: {
        findMany: async (args: any) => {
          // 2ª lectura: las que quedaron PENDING sin boleta (las recién creadas).
          if (args?.where?.invoiceId === null) return opts.fresh ?? [];
          return opts.existing ?? [];
        },
        createMany: async ({ data }: any) => { createdMany.push(...data); return { count: data.length }; },
        update: async ({ where, data }: any) => { updated.push({ where, data }); return { ...where, ...data }; },
      },
      invoice: {
        // Respeta el filtro real: si la query pide `carriedFromPeriodId: null`,
        // las arrastradas no se devuelven.
        findMany: async (args: any) => {
          const all = opts.invoices ?? [];
          return args?.where?.carriedFromPeriodId === null
            ? all.filter((i) => !i.carriedFromPeriodId)
            : all;
        },
        update: async ({ where, data }: any) => { invoiceUpdates.push({ where, data }); return {}; },
      },
    } as any,
  };
}

describe("generateObligationsForPeriod — tipo de documento (spec 2026-09-17)", () => {
  it("factura y retención del mismo proveedor van cada una a la obligación de su tipo, sin importar el orden", async () => {
    // Dos gastos fijos de Mayoral: FACTURA y RETENCION. La retención se creó ANTES
    // que la factura (caso real Pueyrredón/Dogo 09/2026).
    const fake = makeFakePrisma({
      period: { id: "per1", consortiumId: "c1", clientId: "cl1" },
      fixedExpenses: [
        { id: "fx-fact", providerId: "mayoral", lspServiceId: null, kind: "FACTURA" },
        { id: "fx-ret", providerId: "mayoral", lspServiceId: null, kind: "RETENCION" },
      ],
      invoices: [
        { id: "inv-ret", providerId: "mayoral", lspServiceId: null, docKind: "RETENCION" },
        { id: "inv-fact", providerId: "mayoral", lspServiceId: null, docKind: "FACTURA" },
      ],
    });
    const res = await generateObligationsForPeriod("per1", fake.client);
    expect(res.linked).toBe(2);
    const pares = fake.updated.map((u) => [fake.created[Number(u.where.id.split("-")[1]) - 1].fixedExpenseId, u.data.invoiceId]);
    expect(pares).toEqual(expect.arrayContaining([["fx-fact", "inv-fact"], ["fx-ret", "inv-ret"]]));
  });

  it("un gasto fijo FACTURA solo NO toma la retención", async () => {
    const fake = makeFakePrisma({
      period: { id: "per1", consortiumId: "c1", clientId: "cl1" },
      fixedExpenses: [{ id: "fx-fact", providerId: "mayoral", lspServiceId: null, kind: "FACTURA" }],
      invoices: [{ id: "inv-ret", providerId: "mayoral", lspServiceId: null, docKind: "RETENCION" }],
    });
    const res = await generateObligationsForPeriod("per1", fake.client);
    expect(res.created).toBe(1);
    expect(res.linked).toBe(0);
  });
});

describe("syncObligationsForClient", () => {
  it("revincula una boleta suelta a una obligación PENDING aunque no haya creado nada (la principal se borró)", async () => {
    const fake = makeFakeSyncPrisma({
      periods: [{ id: "per1", consortiumId: "c1" }],
      fixedExpenses: [{ id: "fx1", consortiumId: "c1", providerId: "p1", lspServiceId: null }],
      existing: [{ periodId: "per1", fixedExpenseId: "fx1", invoiceId: null }],
      fresh: [{ id: "ob1", periodId: "per1", fixedExpenseId: "fx1" }],
      invoices: [{ id: "inv2", periodId: "per1", providerId: "p1", lspServiceId: null }],
    });

    const res = await syncObligationsForClient("cl1", fake.client);

    expect(res.created).toBe(0);
    expect(res.linked).toBe(1);
    expect(fake.createdMany).toHaveLength(0);
    expect(fake.updated[0]).toMatchObject({ where: { id: "ob1" }, data: { status: "RECEIVED", invoiceId: "inv2" } });
  });

  it("crea las faltantes de todos los períodos activos con un solo createMany", async () => {
    const fake = makeFakeSyncPrisma({
      periods: [
        { id: "per1", consortiumId: "c1" },
        { id: "per2", consortiumId: "c2" },
      ],
      fixedExpenses: [
        { id: "fx1", consortiumId: "c1", providerId: "p1", lspServiceId: null },
        { id: "fx2", consortiumId: "c1", providerId: null, lspServiceId: "l1" },
        { id: "fx3", consortiumId: "c2", providerId: "p2", lspServiceId: null },
      ],
      existing: [{ periodId: "per1", fixedExpenseId: "fx1", invoiceId: null }],
    });

    const res = await syncObligationsForClient("cl1", fake.client);

    expect(res.created).toBe(2); // fx2 en per1 y fx3 en per2
    expect(res.periods).toBe(2);
    expect(fake.createdMany).toHaveLength(2);
    expect(fake.createdMany).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ periodId: "per1", fixedExpenseId: "fx2", status: "PENDING", clientId: "cl1", consortiumId: "c1" }),
        expect.objectContaining({ periodId: "per2", fixedExpenseId: "fx3", status: "PENDING", clientId: "cl1", consortiumId: "c2" }),
      ])
    );
  });

  it("es idempotente: si no falta nada, no escribe", async () => {
    const fake = makeFakeSyncPrisma({
      periods: [{ id: "per1", consortiumId: "c1" }],
      fixedExpenses: [{ id: "fx1", consortiumId: "c1", providerId: "p1", lspServiceId: null }],
      existing: [{ periodId: "per1", fixedExpenseId: "fx1", invoiceId: null }],
    });

    const res = await syncObligationsForClient("cl1", fake.client);

    expect(res).toEqual({ created: 0, linked: 0, periods: 1 });
    expect(fake.createdMany).toHaveLength(0);
    expect(fake.updated).toHaveLength(0);
  });

  it("sin períodos activos no toca nada", async () => {
    const fake = makeFakeSyncPrisma({ periods: [], fixedExpenses: [] });
    const res = await syncObligationsForClient("cl1", fake.client);
    expect(res).toEqual({ created: 0, linked: 0, periods: 0 });
  });

  it("vincula una boleta ya presente a una obligación recién creada", async () => {
    const fake = makeFakeSyncPrisma({
      periods: [{ id: "per1", consortiumId: "c1" }],
      fixedExpenses: [{ id: "fx2", consortiumId: "c1", providerId: null, lspServiceId: "l1" }],
      existing: [],
      invoices: [{ id: "inv9", periodId: "per1", providerId: "pX", lspServiceId: "l1" }],
      fresh: [{ id: "ob9", periodId: "per1", fixedExpenseId: "fx2" }],
    });

    const res = await syncObligationsForClient("cl1", fake.client);

    expect(res.created).toBe(1);
    expect(res.linked).toBe(1);
    expect(fake.updated[0]).toMatchObject({
      where: { id: "ob9" },
      data: { status: "RECEIVED", invoiceId: "inv9" },
    });
  });

  // Una boleta arrastrada conserva su obligación en el período de ORIGEN, y
  // `ExpenseObligation.invoiceId` es unique: vincularla otra vez en el destino
  // reventaría con P2002.
  it("no vincula una boleta arrastrada de otro período", async () => {
    const fake = makeFakeSyncPrisma({
      periods: [{ id: "sep", consortiumId: "c1" }],
      fixedExpenses: [{ id: "fx1", consortiumId: "c1", providerId: "p1", lspServiceId: null }],
      existing: [],
      invoices: [
        { id: "inv-ago", periodId: "sep", providerId: "p1", lspServiceId: null, carriedFromPeriodId: "ago" },
      ],
      fresh: [{ id: "ob-sep", periodId: "sep", fixedExpenseId: "fx1" }],
    });

    const res = await syncObligationsForClient("cl1", fake.client);

    expect(res.linked).toBe(0);
    expect(fake.updated).toHaveLength(0);
  });

  it("no roba una boleta que ya está vinculada a otra obligación", async () => {
    const fake = makeFakeSyncPrisma({
      periods: [{ id: "per1", consortiumId: "c1" }],
      fixedExpenses: [
        { id: "fx1", consortiumId: "c1", providerId: null, lspServiceId: "l1" },
        { id: "fx2", consortiumId: "c1", providerId: "p1", lspServiceId: null },
      ],
      existing: [{ periodId: "per1", fixedExpenseId: "fx1", invoiceId: "inv9" }],
      invoices: [{ id: "inv9", periodId: "per1", providerId: null, lspServiceId: "l1" }],
      fresh: [{ id: "ob2", periodId: "per1", fixedExpenseId: "fx2" }],
    });

    const res = await syncObligationsForClient("cl1", fake.client);

    expect(res.created).toBe(1);
    expect(res.linked).toBe(0);
    expect(fake.updated).toHaveLength(0);
  });
});

/**
 * Fake prisma para `linkInvoiceToObligation`. Registra por separado los updates de
 * la obligación y los de la boleta: lo que se prueba acá es que la etiqueta del
 * gasto fijo se copie a la boleta (spec 2026-09-24).
 */
function makeFakeLinkPrisma(opts: {
  obligations: Array<{
    id: string;
    fixedExpense: {
      providerId: string | null;
      lspServiceId: string | null;
      kind: "FACTURA" | "RETENCION";
      rubroId: string | null;
      coeficienteId: string | null;
    };
  }>;
}) {
  const obligationUpdates: any[] = [];
  const invoiceUpdates: any[] = [];
  return {
    obligationUpdates,
    invoiceUpdates,
    client: {
      expenseObligation: {
        findMany: async () =>
          opts.obligations.map((o, i) => ({ ...o, createdAt: new Date(2026, 0, i + 1) })),
        update: async ({ where, data }: any) => { obligationUpdates.push({ where, data }); return {}; },
      },
      invoice: {
        update: async ({ where, data }: any) => { invoiceUpdates.push({ where, data }); return {}; },
      },
    } as any,
  };
}

describe("linkInvoiceToObligation — rubro y coeficiente", () => {
  it("copia el rubro y el coeficiente del gasto fijo a la boleta", async () => {
    const fake = makeFakeLinkPrisma({
      obligations: [
        {
          id: "ob1",
          fixedExpense: {
            providerId: null, lspServiceId: "l1", kind: "FACTURA",
            rubroId: "r3", coeficienteId: "cA",
          },
        },
      ],
    });
    const linked = await linkInvoiceToObligation(
      { id: "inv1", periodId: "per1", providerId: null, lspServiceId: "l1" },
      fake.client
    );
    expect(linked).toBe(true);
    expect(fake.invoiceUpdates).toHaveLength(1);
    expect(fake.invoiceUpdates[0]).toMatchObject({
      where: { id: "inv1" },
      data: { rubroId: "r3", coeficienteId: "cA" },
    });
  });

  // Un gasto fijo sin etiquetar no tiene que tocar la boleta: si la boleta traía
  // rubro cargado a mano, un null del gasto fijo no lo borra.
  it("no toca la boleta si el gasto fijo no tiene ninguno de los dos", async () => {
    const fake = makeFakeLinkPrisma({
      obligations: [
        {
          id: "ob1",
          fixedExpense: {
            providerId: "p1", lspServiceId: null, kind: "FACTURA",
            rubroId: null, coeficienteId: null,
          },
        },
      ],
    });
    const linked = await linkInvoiceToObligation(
      { id: "inv1", periodId: "per1", providerId: "p1", lspServiceId: null },
      fake.client
    );
    expect(linked).toBe(true);
    expect(fake.invoiceUpdates).toHaveLength(0);
  });

  it("copia sólo el que tiene, si tiene uno solo", async () => {
    const fake = makeFakeLinkPrisma({
      obligations: [
        {
          id: "ob1",
          fixedExpense: {
            providerId: "p1", lspServiceId: null, kind: "FACTURA",
            rubroId: "r5", coeficienteId: null,
          },
        },
      ],
    });
    await linkInvoiceToObligation(
      { id: "inv1", periodId: "per1", providerId: "p1", lspServiceId: null },
      fake.client
    );
    expect(fake.invoiceUpdates[0].data).toEqual({ rubroId: "r5" });
  });
});

describe("syncObligationsForClient — rubro y coeficiente", () => {
  it("copia la etiqueta del gasto fijo al vincular retroactivamente", async () => {
    const fake = makeFakeSyncPrisma({
      periods: [{ id: "per1", consortiumId: "c1" }],
      fixedExpenses: [
        {
          id: "fx1", consortiumId: "c1", providerId: "p1", lspServiceId: null,
          rubroId: "r5", coeficienteId: "cB",
        },
      ],
      fresh: [{ id: "ob1", periodId: "per1", fixedExpenseId: "fx1" }],
      invoices: [{ id: "inv1", periodId: "per1", providerId: "p1", lspServiceId: null }],
    });
    await syncObligationsForClient("cl1", fake.client);
    expect(fake.invoiceUpdates).toHaveLength(1);
    expect(fake.invoiceUpdates[0]).toMatchObject({
      where: { id: "inv1" },
      data: { rubroId: "r5", coeficienteId: "cB" },
    });
  });

  it("no toca la boleta si el gasto fijo no está etiquetado", async () => {
    const fake = makeFakeSyncPrisma({
      periods: [{ id: "per1", consortiumId: "c1" }],
      fixedExpenses: [{ id: "fx1", consortiumId: "c1", providerId: "p1", lspServiceId: null }],
      fresh: [{ id: "ob1", periodId: "per1", fixedExpenseId: "fx1" }],
      invoices: [{ id: "inv1", periodId: "per1", providerId: "p1", lspServiceId: null }],
    });
    await syncObligationsForClient("cl1", fake.client);
    expect(fake.invoiceUpdates).toHaveLength(0);
  });
});
