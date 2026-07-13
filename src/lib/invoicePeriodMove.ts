import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";
import { GoogleDriveService } from "@/services/googleDrive.service";
import { GoogleSheetsService, SheetsRowMapping, SheetRowIndex, findRowInIndex } from "@/services/googleSheets.service";
import { resolveStatementsFolders } from "@/services/statementsFolders.service";
import { buildInvoiceFileName } from "@/lib/statementsNaming";
import { linkInvoiceToObligation } from "@/services/obligation.service";
import { moveLog, shortLogId } from "@/lib/logger";
import {
  loadProcessingClient,
  resolveGoogleConfig,
  resolveSheetName,
  resolveMapping,
  resolveFolders,
} from "@/lib/clientProcessingConfig";
import { DEFAULT_SHEETS_MAPPING } from "@/lib/invoiceDeletion";

export type MoveSkipReason =
  | "sin_periodo"
  | "destino_inexistente"
  | "destino_cerrado"
  | "ya_en_destino"
  | "destino_invalido";

/** Campos de la boleta que usa la migración (proyección del select). */
export interface InvoiceForMove {
  id: string;
  clientId: string;
  periodId: string | null;
  driveFileId: string | null;
  sourceFileUrl: string | null;
  boletaNumber: string | null;
  providerTaxId: string | null;
  provider: string | null;
  consortium: string | null;
  documentHash: string;
  providerId: string | null;
  lspServiceId: string | null;
  periodRef: { year: number; month: number } | null;
  consortiumRef: { id: string; rawName: string; statementsFolderId: string | null } | null;
}

export type ClassifyResult =
  | { skip: MoveSkipReason }
  | {
      periodId: string;
      targetYear: number;
      targetMonth: number;
      fromLabel: string;
      toLabel: string;
    };

export interface MovePreviewResult {
  invoiceId: string;
  consortium: string | null;
  movable: boolean;
  fromLabel?: string;
  toLabel?: string;
  targetPeriodId?: string;
  skip?: MoveSkipReason;
}

/** +1 mes, envolviendo diciembre → enero del año siguiente. */
export function nextPeriod(year: number, month: number): { year: number; month: number } {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

/** "MM/YYYY" (formato de la columna PERIODO en Sheets). */
export function periodLabel(year: number, month: number): string {
  return `${String(month).padStart(2, "0")}/${year}`;
}

/** Carga la boleta con la proyección que usa la migración. Null si no existe. */
export async function loadInvoice(
  prisma: PrismaClient,
  clientId: string,
  invoiceId: string
): Promise<InvoiceForMove | null> {
  return prisma.invoice.findFirst({
    where: { id: invoiceId, clientId },
    select: {
      id: true, clientId: true, periodId: true, driveFileId: true, sourceFileUrl: true,
      boletaNumber: true, providerTaxId: true, provider: true, consortium: true,
      documentHash: true, providerId: true, lspServiceId: true,
      periodRef: { select: { year: true, month: true } },
      consortiumRef: { select: { id: true, rawName: true, statementsFolderId: true } },
    },
  }) as Promise<InvoiceForMove | null>;
}

/**
 * Determina el destino (+1 mes del consorcio de la boleta) o el motivo de skip.
 * - sin_periodo: la boleta no tiene período (o consorcio) actual.
 * - destino_inexistente: no existe el Period +1 de ese consorcio.
 * - destino_cerrado: existe pero no está ACTIVE (no se ensucian períodos cerrados).
 */
export async function classifyTarget(
  prisma: PrismaClient,
  invoice: InvoiceForMove
): Promise<ClassifyResult> {
  if (!invoice.periodId || !invoice.periodRef || !invoice.consortiumRef) {
    return { skip: "sin_periodo" };
  }
  const { year, month } = nextPeriod(invoice.periodRef.year, invoice.periodRef.month);
  const target = await prisma.period.findUnique({
    where: {
      consortiumId_year_month: { consortiumId: invoice.consortiumRef.id, year, month },
    },
    select: { id: true, status: true },
  });
  if (!target) return { skip: "destino_inexistente" };
  if (target.status !== "ACTIVE") return { skip: "destino_cerrado" };
  return {
    periodId: target.id,
    targetYear: year,
    targetMonth: month,
    fromLabel: periodLabel(invoice.periodRef.year, invoice.periodRef.month),
    toLabel: periodLabel(year, month),
  };
}

/**
 * Valida un período destino EXPLÍCITO para el move idempotente (execute). A
 * diferencia de `classifyTarget` (que calcula "mes siguiente del actual" para el
 * preview), acá el destino viene dado y se verifica: existe, ACTIVE, mismo
 * consorcio, y es el mes inmediatamente siguiente al período actual de la boleta.
 * (El caso "ya está en el destino" lo resuelve el caller antes de llamar acá.)
 */
export async function validateTarget(
  prisma: PrismaClient,
  invoice: InvoiceForMove,
  targetPeriodId: string
): Promise<{ skip: MoveSkipReason } | { periodId: string; year: number; month: number; fromLabel: string; toLabel: string }> {
  if (!invoice.periodId || !invoice.periodRef || !invoice.consortiumRef) {
    return { skip: "sin_periodo" };
  }
  const target = await prisma.period.findUnique({
    where: { id: targetPeriodId },
    select: { id: true, status: true, consortiumId: true, year: true, month: true },
  });
  if (!target || target.status !== "ACTIVE" || target.consortiumId !== invoice.consortiumRef.id) {
    return { skip: "destino_invalido" };
  }
  const next = nextPeriod(invoice.periodRef.year, invoice.periodRef.month);
  if (target.year !== next.year || target.month !== next.month) {
    return { skip: "destino_invalido" };
  }
  return {
    periodId: target.id,
    year: target.year,
    month: target.month,
    fromLabel: periodLabel(invoice.periodRef.year, invoice.periodRef.month),
    toLabel: periodLabel(target.year, target.month),
  };
}

/** Preview sin efectos: para cada id calcula movible/skip (sólo lecturas de DB). */
export async function previewMove(
  prisma: PrismaClient,
  clientId: string,
  invoiceIds: string[]
): Promise<MovePreviewResult[]> {
  const results: MovePreviewResult[] = [];
  for (const invoiceId of invoiceIds) {
    const invoice = await loadInvoice(prisma, clientId, invoiceId);
    if (!invoice) {
      results.push({ invoiceId, consortium: null, movable: false });
      continue;
    }
    const name = invoice.consortium ?? invoice.consortiumRef?.rawName ?? null;
    const cls = await classifyTarget(prisma, invoice);
    if ("skip" in cls) {
      results.push({ invoiceId, consortium: name, movable: false, skip: cls.skip });
    } else {
      results.push({
        invoiceId, consortium: name, movable: true,
        fromLabel: cls.fromLabel, toLabel: cls.toLabel, targetPeriodId: cls.periodId,
      });
    }
  }
  return results;
}

export type MoveInvoiceResult =
  | { ok: true; fromLabel: string; toLabel: string }
  | { ok: false; skip: MoveSkipReason }
  | { ok: false; error: string; reverted: boolean };

export interface InvoiceMoveContext {
  prisma: PrismaClient;
  drive: GoogleDriveService;
  sheets: GoogleSheetsService;
  statementsRootId: string;
  sheetName: string;
  mapping: SheetsRowMapping;
  /** Índice de filas de la hoja, pre-cargado por lote para no re-leer por boleta. */
  sheetRowIndex?: SheetRowIndex;
  /** Seams inyectables (default a la impl real; se sobreescriben en tests). */
  resolveStatements?: typeof resolveStatementsFolders;
  applyDb?: (invoice: InvoiceForMove, newPeriodId: string) => Promise<void>;
}

/**
 * Transacción de DB: reasigna el período y reajusta la obligación de gasto fijo.
 * Es el ÚLTIMO paso; si lanza, Prisma hace rollback → no requiere compensación manual.
 */
export async function applyDbMove(
  prisma: PrismaClient,
  invoice: InvoiceForMove,
  newPeriodId: string
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // La obligación vinculada a esta boleta (si hay) vuelve a PENDING.
    await tx.expenseObligation.updateMany({
      where: { invoiceId: invoice.id },
      data: { status: "PENDING", invoiceId: null },
    });
    await tx.invoice.update({ where: { id: invoice.id }, data: { periodId: newPeriodId } });
    // Re-vincula a una obligación PENDING del período nuevo, si matchea.
    await linkInvoiceToObligation(
      { id: invoice.id, periodId: newPeriodId, providerId: invoice.providerId, lspServiceId: invoice.lspServiceId },
      tx as unknown as PrismaClient
    );
  });
}

/**
 * Mueve UNA boleta al período destino EXPLÍCITO `targetPeriodId` (idempotente).
 * Orden: Drive → Sheets → DB, con pila de compensación LIFO por boleta.
 *  - Si la boleta ya está en el destino → no-op (`ya_en_destino`).
 *  - Valida el destino (ACTIVE, mismo consorcio, mes siguiente) → sino `destino_invalido`.
 * Usa `ctx.sheetRowIndex` si está (escritura sin re-leer la hoja); si no, cae al
 * método que re-lee (`updateInvoicePeriodCell`). Nunca lanza.
 */
export async function moveOneInvoiceToTarget(
  ctx: InvoiceMoveContext,
  clientId: string,
  invoiceId: string,
  targetPeriodId: string
): Promise<MoveInvoiceResult> {
  const started = Date.now();
  const tag = shortLogId(invoiceId);

  const invoice = await loadInvoice(ctx.prisma, clientId, invoiceId);
  if (!invoice) return { ok: false, error: "Boleta no encontrada", reverted: true };

  // Idempotencia: ya está en el destino → no-op.
  if (invoice.periodId === targetPeriodId) {
    moveLog.info(tag, "skip ya_en_destino");
    return { ok: false, skip: "ya_en_destino" };
  }

  const v = await validateTarget(ctx.prisma, invoice, targetPeriodId);
  if ("skip" in v) {
    moveLog.info(tag, `skip ${v.skip}`);
    return { ok: false, skip: v.skip };
  }

  const resolveStmts = ctx.resolveStatements ?? resolveStatementsFolders;
  const applyDb = ctx.applyDb ?? ((inv, pid) => applyDbMove(ctx.prisma, inv, pid));

  const oldFileName = buildInvoiceFileName({
    provider: invoice.provider, consortium: invoice.consortium,
    month: invoice.periodRef!.month, year: invoice.periodRef!.year,
    boletaNumber: invoice.boletaNumber, documentHash: invoice.documentHash,
  });
  const newFileName = buildInvoiceFileName({
    provider: invoice.provider, consortium: invoice.consortium,
    month: v.month, year: v.year,
    boletaNumber: invoice.boletaNumber, documentHash: invoice.documentHash,
  });

  const sheetKeys = {
    boletaNumber: invoice.boletaNumber,
    sourceFileUrl: invoice.sourceFileUrl,
    providerTaxId: invoice.providerTaxId,
  };
  const compensations: Array<() => Promise<unknown>> = [];
  let step = "start";

  try {
    // 1. Drive (mover + renombrar). Sólo si la boleta tiene archivo.
    if (invoice.driveFileId) {
      step = "drive";
      const fileId = invoice.driveFileId;
      const parents = await ctx.drive.getFileParents(fileId);
      const oldParent = parents[0] ?? null;
      const { periodFolderId } = await resolveStmts({
        drive: ctx.drive,
        statementsRootId: ctx.statementsRootId,
        consortium: {
          id: invoice.consortiumRef!.id,
          rawName: invoice.consortiumRef!.rawName,
          statementsFolderId: invoice.consortiumRef!.statementsFolderId,
        },
        month: v.month,
        year: v.year,
      });

      if (oldParent && oldParent !== periodFolderId) {
        await ctx.drive.moveAndRenameFile(fileId, oldParent, periodFolderId, newFileName);
        compensations.push(() => ctx.drive.moveAndRenameFile(fileId, periodFolderId, oldParent, oldFileName));
      } else {
        // Misma carpeta o sin parent conocido → sólo renombrar.
        await ctx.drive.renameFile(fileId, newFileName);
        compensations.push(() => ctx.drive.renameFile(fileId, oldFileName));
      }
    }

    // 2. Sheets: celda PERIODO (M) → destino.
    step = "sheets";
    if (ctx.sheetRowIndex) {
      const rowNumber = findRowInIndex(ctx.sheetRowIndex, sheetKeys);
      if (rowNumber >= 2) {
        await ctx.sheets.updatePeriodCellAtRow(ctx.sheetName, ctx.mapping, rowNumber, v.toLabel);
        compensations.push(() => ctx.sheets.updatePeriodCellAtRow(ctx.sheetName, ctx.mapping, rowNumber, v.fromLabel));
      }
    } else {
      await ctx.sheets.updateInvoicePeriodCell(ctx.sheetName, ctx.mapping, sheetKeys, v.toLabel);
      compensations.push(() => ctx.sheets.updateInvoicePeriodCell(ctx.sheetName, ctx.mapping, sheetKeys, v.fromLabel));
    }

    // 3. DB (última, transaccional).
    step = "db";
    await applyDb(invoice, v.periodId);

    moveLog.info(tag, `ok ${v.fromLabel}->${v.toLabel} ${Date.now() - started}ms`);
    return { ok: true, fromLabel: v.fromLabel, toLabel: v.toLabel };
  } catch (err) {
    let reverted = true;
    for (const comp of compensations.reverse()) {
      try {
        await comp();
      } catch {
        reverted = false;
      }
    }
    const msg = err instanceof Error ? err.message : "Error";
    moveLog.error(tag, `failed step=${step} reverted=${reverted}: ${msg} (${Date.now() - started}ms)`);
    return { ok: false, error: msg, reverted };
  }
}

export interface BulkMoveSummary {
  moved: number;
  skipped: Array<{ invoiceId: string; reason: MoveSkipReason }>;
  failed: Array<{ invoiceId: string; error: string; reverted: boolean }>;
  total: number;
}

/**
 * Resuelve el contexto de Google (Drive + Sheets + config) UNA vez por lote.
 * Espeja `resolveDeletionContext`. Exige la carpeta Rendiciones (statements).
 */
export async function resolveMoveContext(
  clientId: string
): Promise<{ ctx: InvoiceMoveContext } | { error: string; status: number }> {
  const processingClient = await loadProcessingClient(clientId);
  if (!processingClient) return { error: "Cliente no encontrado", status: 404 };

  const googleConfig = resolveGoogleConfig(processingClient);
  if (!googleConfig) return { error: "Sin credenciales de Google configuradas", status: 400 };

  const folders = resolveFolders(processingClient);
  if (!folders.statements) {
    return { error: "Falta la carpeta Rendiciones (statements) en la config del cliente", status: 400 };
  }

  return {
    ctx: {
      prisma: getPrismaClient(),
      drive: new GoogleDriveService(googleConfig),
      sheets: new GoogleSheetsService(googleConfig),
      statementsRootId: folders.statements,
      sheetName: resolveSheetName(processingClient),
      mapping: resolveMapping(processingClient) ?? DEFAULT_SHEETS_MAPPING,
    },
  };
}

/**
 * Mueve un lote de boletas a sus períodos destino explícitos. Pre-carga el índice
 * de filas de Sheets UNA vez (evita N lecturas completas). Una boleta fallida o
 * salteada no aborta el resto.
 */
export async function moveInvoicesToTargets(
  ctx: InvoiceMoveContext,
  clientId: string,
  moves: Array<{ invoiceId: string; targetPeriodId: string }>
): Promise<BulkMoveSummary> {
  const started = Date.now();

  if (!ctx.sheetRowIndex) {
    try {
      ctx.sheetRowIndex = await ctx.sheets.loadRowIndex(ctx.sheetName, ctx.mapping);
    } catch (err) {
      moveLog.warn("batch", `no se pudo pre-cargar el índice de Sheets: ${err instanceof Error ? err.message : "Error"}`);
    }
  }

  let moved = 0;
  const skipped: BulkMoveSummary["skipped"] = [];
  const failed: BulkMoveSummary["failed"] = [];

  for (const { invoiceId, targetPeriodId } of moves) {
    const r = await moveOneInvoiceToTarget(ctx, clientId, invoiceId, targetPeriodId);
    if (r.ok) moved += 1;
    else if ("skip" in r) skipped.push({ invoiceId, reason: r.skip });
    else failed.push({ invoiceId, error: r.error, reverted: r.reverted });
  }

  moveLog.info("batch", `total=${moves.length} moved=${moved} skipped=${skipped.length} failed=${failed.length} ${Date.now() - started}ms`);
  return { moved, skipped, failed, total: moves.length };
}
