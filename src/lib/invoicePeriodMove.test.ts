import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { nextPeriod, classifyTarget, previewMove, validateTarget } from "./invoicePeriodMove";

/** Invoice mínimo con los campos que usa la migración. */
function fakeInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv1",
    clientId: "cli1",
    periodId: "perJun",
    driveFileId: "file1",
    sourceFileUrl: "https://drive/inv1",
    boletaNumber: "0001-00001234",
    providerTaxId: "30-11111111-1",
    provider: "EDESUR",
    consortium: "ALMIRANTE BROWN 706",
    documentHash: "abcdef1234567890",
    providerId: "prov1",
    lspServiceId: null,
    periodRef: { year: 2026, month: 6 },
    consortiumRef: { id: "cons1", rawName: "ALMIRANTE BROWN 706", statementsFolderId: "bld1" },
    ...overrides,
  };
}

/** Prisma falso: sólo las lecturas que usa classify/preview. */
function fakePrisma(invoice: unknown, targetPeriod: unknown): PrismaClient {
  return {
    invoice: { findFirst: async () => invoice },
    period: { findUnique: async () => targetPeriod },
  } as unknown as PrismaClient;
}

describe("nextPeriod", () => {
  it("avanza un mes dentro del año", () => {
    expect(nextPeriod(2026, 6)).toEqual({ year: 2026, month: 7 });
  });
  it("envuelve diciembre a enero del año siguiente", () => {
    expect(nextPeriod(2026, 12)).toEqual({ year: 2027, month: 1 });
  });
});

describe("classifyTarget", () => {
  it("skip 'sin_periodo' cuando la boleta no tiene período", async () => {
    const prisma = fakePrisma(fakeInvoice({ periodId: null, periodRef: null }), null);
    const inv = await prisma.invoice.findFirst({} as never);
    const res = await classifyTarget(prisma, inv as never);
    expect(res).toEqual({ skip: "sin_periodo" });
  });

  it("skip 'destino_inexistente' cuando no existe el período +1", async () => {
    const prisma = fakePrisma(fakeInvoice(), null);
    const inv = await prisma.invoice.findFirst({} as never);
    const res = await classifyTarget(prisma, inv as never);
    expect(res).toEqual({ skip: "destino_inexistente" });
  });

  it("skip 'destino_cerrado' cuando el período +1 existe pero está CLOSED", async () => {
    const prisma = fakePrisma(fakeInvoice(), { id: "perJul", status: "CLOSED" });
    const inv = await prisma.invoice.findFirst({} as never);
    const res = await classifyTarget(prisma, inv as never);
    expect(res).toEqual({ skip: "destino_cerrado" });
  });

  it("resuelve destino ACTIVE con etiquetas from/to", async () => {
    const prisma = fakePrisma(fakeInvoice(), { id: "perJul", status: "ACTIVE" });
    const inv = await prisma.invoice.findFirst({} as never);
    const res = await classifyTarget(prisma, inv as never);
    expect(res).toEqual({
      periodId: "perJul",
      targetYear: 2026,
      targetMonth: 7,
      fromLabel: "06/2026",
      toLabel: "07/2026",
    });
  });
});

describe("previewMove", () => {
  it("marca movable + etiquetas para destino ACTIVE", async () => {
    const prisma = fakePrisma(fakeInvoice(), { id: "perJul", status: "ACTIVE" });
    const [row] = await previewMove(prisma, "cli1", ["inv1"]);
    expect(row).toEqual({
      invoiceId: "inv1",
      consortium: "ALMIRANTE BROWN 706",
      movable: true,
      fromLabel: "06/2026",
      toLabel: "07/2026",
      targetPeriodId: "perJul",
    });
  });

  it("marca no-movable con motivo para destino cerrado", async () => {
    const prisma = fakePrisma(fakeInvoice(), { id: "perJul", status: "CLOSED" });
    const [row] = await previewMove(prisma, "cli1", ["inv1"]);
    expect(row).toMatchObject({ invoiceId: "inv1", movable: false, skip: "destino_cerrado" });
  });
});

describe("validateTarget", () => {
  it("skip 'sin_periodo' si la boleta no tiene período", async () => {
    const prisma = fakePrisma(fakeInvoice({ periodId: null, periodRef: null }), null);
    const inv = await prisma.invoice.findFirst({} as never);
    expect(await validateTarget(prisma, inv as never, "perJul")).toEqual({ skip: "sin_periodo" });
  });

  it("skip 'destino_invalido' si el destino no existe", async () => {
    const prisma = fakePrisma(fakeInvoice(), null);
    const inv = await prisma.invoice.findFirst({} as never);
    expect(await validateTarget(prisma, inv as never, "perJul")).toEqual({ skip: "destino_invalido" });
  });

  it("skip 'destino_invalido' si el destino no está ACTIVE", async () => {
    const prisma = fakePrisma(fakeInvoice(), { id: "perJul", status: "CLOSED", consortiumId: "cons1", year: 2026, month: 7 });
    const inv = await prisma.invoice.findFirst({} as never);
    expect(await validateTarget(prisma, inv as never, "perJul")).toEqual({ skip: "destino_invalido" });
  });

  it("skip 'destino_invalido' si el destino es de otro consorcio", async () => {
    const prisma = fakePrisma(fakeInvoice(), { id: "perJul", status: "ACTIVE", consortiumId: "OTRO", year: 2026, month: 7 });
    const inv = await prisma.invoice.findFirst({} as never);
    expect(await validateTarget(prisma, inv as never, "perJul")).toEqual({ skip: "destino_invalido" });
  });

  it("skip 'destino_invalido' si el destino no es el mes inmediatamente siguiente", async () => {
    const prisma = fakePrisma(fakeInvoice(), { id: "perAgo", status: "ACTIVE", consortiumId: "cons1", year: 2026, month: 8 });
    const inv = await prisma.invoice.findFirst({} as never);
    expect(await validateTarget(prisma, inv as never, "perAgo")).toEqual({ skip: "destino_invalido" });
  });

  it("destino válido (ACTIVE, mismo consorcio, mes siguiente) → datos del move", async () => {
    const prisma = fakePrisma(fakeInvoice(), { id: "perJul", status: "ACTIVE", consortiumId: "cons1", year: 2026, month: 7 });
    const inv = await prisma.invoice.findFirst({} as never);
    expect(await validateTarget(prisma, inv as never, "perJul")).toEqual({
      periodId: "perJul", year: 2026, month: 7, fromLabel: "06/2026", toLabel: "07/2026",
    });
  });
});

/** Drive falso: registra llamadas; puede lanzar en la N-ésima llamada de move/rename. */
function fakeDrive(throwOnDriveCall?: number) {
  const calls: string[] = [];
  let n = 0;
  const move = async (fileId: string, from: string, to: string, name: string) => {
    n += 1;
    calls.push(`move:${from}->${to}:${name}`);
    if (throwOnDriveCall === n) throw new Error("drive fail");
  };
  return {
    calls,
    getFileParents: async () => ["OLD_FOLDER"],
    moveAndRenameFile: move,
    renameFile: async (_id: string, name: string) => { calls.push(`rename:${name}`); },
  };
}

/** Sheets falso: registra el valor de period escrito; puede lanzar la 1ª vez. */
function fakeSheets(throwFirst = false) {
  const calls: string[] = [];
  let n = 0;
  return {
    calls,
    updateInvoicePeriodCell: async (
      _sheet: string, _map: unknown, _keys: unknown, periodLabel: string
    ) => {
      n += 1;
      calls.push(`period:${periodLabel}`);
      if (throwFirst && n === 1) throw new Error("sheets fail");
      return true;
    },
  };
}

import { moveOneInvoiceToTarget, type InvoiceMoveContext } from "./invoicePeriodMove";

function makeCtx(opts: {
  invoice?: Record<string, unknown>;
  target?: unknown;
  drive: ReturnType<typeof fakeDrive>;
  sheets: ReturnType<typeof fakeSheets>;
  order: string[];
  dbThrows?: boolean;
}): InvoiceMoveContext {
  const invoice = fakeInvoice(opts.invoice);
  // ACTIVE, mismo consorcio (cons1), mes siguiente (07/2026) por default.
  const target = "target" in opts ? opts.target : { id: "perJul", status: "ACTIVE", consortiumId: "cons1", year: 2026, month: 7 };
  return {
    prisma: fakePrisma(invoice, target),
    drive: opts.drive as never,
    sheets: opts.sheets as never,
    statementsRootId: "ROOT",
    sheetName: "Datos",
    mapping: {} as never,
    resolveStatements: async () => ({ buildingFolderId: "bld1", periodFolderId: "NEW_FOLDER" }),
    applyDb: async () => {
      opts.order.push("db");
      if (opts.dbThrows) throw new Error("db fail");
    },
  };
}

describe("moveOneInvoiceToTarget", () => {
  it("camino feliz: orden Drive → Sheets → DB y etiquetas correctas", async () => {
    const order: string[] = [];
    const drive = fakeDrive();
    const sheets = fakeSheets();
    const drive2 = { ...drive, moveAndRenameFile: async (...a: [string, string, string, string]) => { order.push("drive"); return drive.moveAndRenameFile(...a); } };
    const sheets2 = { ...sheets, updateInvoicePeriodCell: async (...a: [string, unknown, unknown, string]) => { order.push("sheets"); return sheets.updateInvoicePeriodCell(...a); } };
    const ctx = makeCtx({ drive: drive2 as never, sheets: sheets2 as never, order });

    const res = await moveOneInvoiceToTarget(ctx, "cli1", "inv1", "perJul");

    expect(res).toEqual({ ok: true, fromLabel: "06/2026", toLabel: "07/2026" });
    expect(order).toEqual(["drive", "sheets", "db"]);
    expect(drive.calls[0]).toBe("move:OLD_FOLDER->NEW_FOLDER:EDESUR - ALMIRANTE BROWN 706 - P07-2026 - 0001-00001234.pdf");
  });

  it("idempotencia: si ya está en el destino → skip ya_en_destino sin tocar nada", async () => {
    const order: string[] = [];
    const drive = fakeDrive();
    const sheets = fakeSheets();
    const ctx = makeCtx({ invoice: { periodId: "perJul" }, drive, sheets, order });

    const res = await moveOneInvoiceToTarget(ctx, "cli1", "inv1", "perJul");

    expect(res).toEqual({ ok: false, skip: "ya_en_destino" });
    expect(drive.calls).toEqual([]);
    expect(sheets.calls).toEqual([]);
    expect(order).toEqual([]);
  });

  it("destino inválido (otro consorcio) → skip destino_invalido sin tocar nada", async () => {
    const order: string[] = [];
    const drive = fakeDrive();
    const sheets = fakeSheets();
    const ctx = makeCtx({ target: { id: "perJul", status: "ACTIVE", consortiumId: "OTRO", year: 2026, month: 7 }, drive, sheets, order });

    const res = await moveOneInvoiceToTarget(ctx, "cli1", "inv1", "perJul");

    expect(res).toEqual({ ok: false, skip: "destino_invalido" });
    expect(drive.calls).toEqual([]);
  });

  it("falla Sheets → revierte Drive, reverted:true", async () => {
    const order: string[] = [];
    const drive = fakeDrive();
    const sheets = fakeSheets(true); // lanza en la 1ª escritura
    const ctx = makeCtx({ drive, sheets, order });

    const res = await moveOneInvoiceToTarget(ctx, "cli1", "inv1", "perJul");

    expect(res).toEqual({ ok: false, error: "sheets fail", reverted: true });
    expect(drive.calls).toEqual([
      "move:OLD_FOLDER->NEW_FOLDER:EDESUR - ALMIRANTE BROWN 706 - P07-2026 - 0001-00001234.pdf",
      "move:NEW_FOLDER->OLD_FOLDER:EDESUR - ALMIRANTE BROWN 706 - P06-2026 - 0001-00001234.pdf",
    ]);
  });

  it("falla DB (último) → revierte Sheets y Drive (LIFO), reverted:true", async () => {
    const order: string[] = [];
    const drive = fakeDrive();
    const sheets = fakeSheets();
    const ctx = makeCtx({ drive, sheets, order, dbThrows: true });

    const res = await moveOneInvoiceToTarget(ctx, "cli1", "inv1", "perJul");

    expect(res).toEqual({ ok: false, error: "db fail", reverted: true });
    expect(sheets.calls).toEqual(["period:07/2026", "period:06/2026"]);
    expect(drive.calls.length).toBe(2);
  });

  it("si una compensación falla → reverted:false", async () => {
    const order: string[] = [];
    const drive = fakeDrive(2); // la 2ª llamada de drive (la compensación) lanza
    const sheets = fakeSheets();
    const ctx = makeCtx({ drive, sheets, order, dbThrows: true });

    const res = await moveOneInvoiceToTarget(ctx, "cli1", "inv1", "perJul");

    expect(res).toMatchObject({ ok: false, error: "db fail", reverted: false });
  });
});
