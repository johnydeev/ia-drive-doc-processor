import { describe, it, expect } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { nextPeriod, classifyTarget, previewMove } from "./invoicePeriodMove";

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
    });
  });

  it("marca no-movable con motivo para destino cerrado", async () => {
    const prisma = fakePrisma(fakeInvoice(), { id: "perJul", status: "CLOSED" });
    const [row] = await previewMove(prisma, "cli1", ["inv1"]);
    expect(row).toMatchObject({ invoiceId: "inv1", movable: false, skip: "destino_cerrado" });
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
    updateInvoicePaymentInfo: async (
      _sheet: string, _map: unknown, _keys: unknown, values: { period?: string }
    ) => {
      n += 1;
      calls.push(`period:${values.period}`);
      if (throwFirst && n === 1) throw new Error("sheets fail");
      return true;
    },
  };
}

function makeCtx(opts: {
  invoice?: Record<string, unknown>;
  target?: unknown;
  drive: ReturnType<typeof fakeDrive>;
  sheets: ReturnType<typeof fakeSheets>;
  order: string[];
  dbThrows?: boolean;
}): InvoiceMoveContext {
  const invoice = fakeInvoice(opts.invoice);
  // "target" in opts distingue null explícito (destino inexistente) de no-provisto.
  const target = "target" in opts ? opts.target : { id: "perJul", status: "ACTIVE" };
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

import { moveOneInvoiceToNextPeriod, type InvoiceMoveContext } from "./invoicePeriodMove";

describe("moveOneInvoiceToNextPeriod", () => {
  it("camino feliz: orden Drive → Sheets → DB y etiquetas correctas", async () => {
    const order: string[] = [];
    const drive = fakeDrive();
    const sheets = fakeSheets();
    // envolver drive/sheets para registrar el orden global
    const drive2 = { ...drive, moveAndRenameFile: async (...a: [string, string, string, string]) => { order.push("drive"); return drive.moveAndRenameFile(...a); } };
    const sheets2 = { ...sheets, updateInvoicePaymentInfo: async (...a: [string, unknown, unknown, { period?: string }]) => { order.push("sheets"); return sheets.updateInvoicePaymentInfo(...a); } };
    const ctx = makeCtx({ drive: drive2 as never, sheets: sheets2 as never, order });

    const res = await moveOneInvoiceToNextPeriod(ctx, "cli1", "inv1");

    expect(res).toEqual({ ok: true, fromLabel: "06/2026", toLabel: "07/2026" });
    expect(order).toEqual(["drive", "sheets", "db"]);
    expect(drive.calls[0]).toBe("move:OLD_FOLDER->NEW_FOLDER:EDESUR - ALMIRANTE BROWN 706 - P07-2026 - 0001-00001234.pdf");
  });

  it("falla Sheets → revierte Drive y reporta reverted:true", async () => {
    const order: string[] = [];
    const drive = fakeDrive();
    const sheets = fakeSheets(true); // lanza en la 1ª escritura
    const ctx = makeCtx({ drive, sheets, order });

    const res = await moveOneInvoiceToNextPeriod(ctx, "cli1", "inv1");

    expect(res).toEqual({ ok: false, error: "sheets fail", reverted: true });
    // Drive: forward + compensación (volver a OLD_FOLDER con nombre viejo)
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

    const res = await moveOneInvoiceToNextPeriod(ctx, "cli1", "inv1");

    expect(res).toEqual({ ok: false, error: "db fail", reverted: true });
    // Sheets: forward "07/2026" + compensación "06/2026"
    expect(sheets.calls).toEqual(["period:07/2026", "period:06/2026"]);
    // Drive: forward + compensación
    expect(drive.calls.length).toBe(2);
  });

  it("si una compensación falla → reverted:false", async () => {
    const order: string[] = [];
    const drive = fakeDrive(2); // la 2ª llamada de drive (la compensación) lanza
    const sheets = fakeSheets();
    const ctx = makeCtx({ drive, sheets, order, dbThrows: true });

    const res = await moveOneInvoiceToNextPeriod(ctx, "cli1", "inv1");

    expect(res).toMatchObject({ ok: false, error: "db fail", reverted: false });
  });

  it("skip se propaga sin tocar Drive/Sheets", async () => {
    const order: string[] = [];
    const drive = fakeDrive();
    const sheets = fakeSheets();
    const ctx = makeCtx({ drive, sheets, order, target: null }); // destino_inexistente

    const res = await moveOneInvoiceToNextPeriod(ctx, "cli1", "inv1");

    expect(res).toEqual({ ok: false, skip: "destino_inexistente" });
    expect(drive.calls).toEqual([]);
    expect(sheets.calls).toEqual([]);
  });
});
