import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Tests de `deleteInvoicesWithIndex`: el objetivo central es garantizar que el
 * lote lee la hoja UNA sola vez (loadRowIndex) en vez de una lectura por boleta
 * (el patrón que empujaba a bulk-delete al timeout 524 del túnel).
 */

const findFirst = vi.fn();
vi.mock("@/lib/prisma", () => ({
  getPrismaClient: () => ({
    invoice: { findFirst },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        receipt: { delete: vi.fn() },
        expenseObligation: { updateMany: vi.fn() },
        invoice: { delete: vi.fn() },
      })
    ),
  }),
}));

import {
  deleteInvoicesWithIndex,
  DEFAULT_SHEETS_MAPPING,
  type InvoiceDeletionContext,
} from "./invoiceDeletion";

const fakeInvoice = {
  id: "inv-1",
  clientId: "cli-1",
  driveFileId: null,
  sourceFileUrl: "url-a",
  boletaNumber: "0001",
  providerTaxId: "30-11111111-8",
  _count: { payments: 0 },
  receipt: null,
};

function makeCtx() {
  const loadRowIndex = vi.fn(async () => ({
    bySource: new Map([
      ["url-a", 2],
      ["url-b", 3],
    ]),
    byBoleta: new Map<string, { row: number; tax: string }>(),
  }));
  const deleteRowAtNumber = vi.fn(async () => true);
  const ctx = {
    driveService: { getFileParents: vi.fn(), moveFileToFolder: vi.fn(), trashFile: vi.fn() },
    sheetsService: { loadRowIndex, deleteRowAtNumber },
    folders: { pending: "f-pending", failed: "f-failed", scanned: null, unassigned: null },
    sheetName: "Datos",
    mapping: DEFAULT_SHEETS_MAPPING,
  } as unknown as InvoiceDeletionContext;
  return { ctx, loadRowIndex, deleteRowAtNumber };
}

beforeEach(() => {
  findFirst.mockReset();
});

describe("deleteInvoicesWithIndex", () => {
  it("lee la hoja UNA sola vez para todo el lote y ajusta las filas tras cada borrado", async () => {
    findFirst
      .mockResolvedValueOnce({ ...fakeInvoice, id: "inv-1", sourceFileUrl: "url-a" })
      .mockResolvedValueOnce({ ...fakeInvoice, id: "inv-2", sourceFileUrl: "url-b" });
    const { ctx, loadRowIndex, deleteRowAtNumber } = makeCtx();

    const results = await deleteInvoicesWithIndex(ctx, "cli-1", ["inv-1", "inv-2"], "pending");

    expect(loadRowIndex).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.ok)).toBe(true);
    // url-a estaba en fila 2; url-b en fila 3, pero tras borrar la 2 sube a la 2.
    expect(deleteRowAtNumber).toHaveBeenNthCalledWith(1, "Datos", 2);
    expect(deleteRowAtNumber).toHaveBeenNthCalledWith(2, "Datos", 2);
  });

  it("boleta inexistente reporta 404 sin abortar el lote", async () => {
    findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...fakeInvoice, id: "inv-2", sourceFileUrl: "url-b" });
    const { ctx } = makeCtx();

    const results = await deleteInvoicesWithIndex(ctx, "cli-1", ["inv-x", "inv-2"], "pending");

    expect(results[0]).toMatchObject({ ok: false, status: 404 });
    expect(results[1].ok).toBe(true);
  });

  it("fila no encontrada en el índice: continúa (Sheets ya estaba desincronizado)", async () => {
    findFirst.mockResolvedValueOnce({ ...fakeInvoice, sourceFileUrl: "url-zzz", boletaNumber: null });
    const { ctx, deleteRowAtNumber } = makeCtx();

    const results = await deleteInvoicesWithIndex(ctx, "cli-1", ["inv-1"], "pending");

    expect(results[0].ok).toBe(true);
    expect(deleteRowAtNumber).not.toHaveBeenCalled();
  });
});
