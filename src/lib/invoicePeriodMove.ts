import type { PrismaClient } from "@prisma/client";
import { getPrismaClient } from "@/lib/prisma";
import { GoogleDriveService } from "@/services/googleDrive.service";
import { GoogleSheetsService, SheetsRowMapping } from "@/services/googleSheets.service";
import { resolveStatementsFolders } from "@/services/statementsFolders.service";
import { buildInvoiceFileName } from "@/lib/statementsNaming";
import { linkInvoiceToObligation } from "@/services/obligation.service";
import {
  loadProcessingClient,
  resolveGoogleConfig,
  resolveSheetName,
  resolveMapping,
  resolveFolders,
} from "@/lib/clientProcessingConfig";
import { DEFAULT_SHEETS_MAPPING } from "@/lib/invoiceDeletion";

export type MoveSkipReason = "sin_periodo" | "destino_inexistente" | "destino_cerrado";

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
        fromLabel: cls.fromLabel, toLabel: cls.toLabel,
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
 * Mueve UNA boleta al período siguiente de su consorcio. Orden: Drive → Sheets → DB.
 * Ante cualquier fallo revierte lo ya hecho (pila de compensación LIFO) → la boleta
 * queda como estaba. Nunca lanza: devuelve un resultado discriminado.
 */
export async function moveOneInvoiceToNextPeriod(
  ctx: InvoiceMoveContext,
  clientId: string,
  invoiceId: string
): Promise<MoveInvoiceResult> {
  const invoice = await loadInvoice(ctx.prisma, clientId, invoiceId);
  if (!invoice) return { ok: false, error: "Boleta no encontrada", reverted: true };

  const cls = await classifyTarget(ctx.prisma, invoice);
  if ("skip" in cls) return { ok: false, skip: cls.skip };

  const resolveStmts = ctx.resolveStatements ?? resolveStatementsFolders;
  const applyDb = ctx.applyDb ?? ((inv, pid) => applyDbMove(ctx.prisma, inv, pid));

  const oldFileName = buildInvoiceFileName({
    provider: invoice.provider, consortium: invoice.consortium,
    month: invoice.periodRef!.month, year: invoice.periodRef!.year,
    boletaNumber: invoice.boletaNumber, documentHash: invoice.documentHash,
  });
  const newFileName = buildInvoiceFileName({
    provider: invoice.provider, consortium: invoice.consortium,
    month: cls.targetMonth, year: cls.targetYear,
    boletaNumber: invoice.boletaNumber, documentHash: invoice.documentHash,
  });

  const compensations: Array<() => Promise<unknown>> = [];

  try {
    // 1. Drive (mover + renombrar). Sólo si la boleta tiene archivo.
    if (invoice.driveFileId) {
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
        month: cls.targetMonth,
        year: cls.targetYear,
      });

      if (oldParent && oldParent !== periodFolderId) {
        await ctx.drive.moveAndRenameFile(fileId, oldParent, periodFolderId, newFileName);
        compensations.push(() =>
          ctx.drive.moveAndRenameFile(fileId, periodFolderId, oldParent, oldFileName)
        );
      } else {
        // Misma carpeta o sin parent conocido → sólo renombrar.
        await ctx.drive.renameFile(fileId, newFileName);
        compensations.push(() => ctx.drive.renameFile(fileId, oldFileName));
      }
    }

    // 2. Sheets: celda PERIODO (M) → destino.
    await ctx.sheets.updateInvoicePaymentInfo(
      ctx.sheetName, ctx.mapping,
      { boletaNumber: invoice.boletaNumber, sourceFileUrl: invoice.sourceFileUrl, providerTaxId: invoice.providerTaxId },
      { period: cls.toLabel }
    );
    compensations.push(() =>
      ctx.sheets.updateInvoicePaymentInfo(
        ctx.sheetName, ctx.mapping,
        { boletaNumber: invoice.boletaNumber, sourceFileUrl: invoice.sourceFileUrl, providerTaxId: invoice.providerTaxId },
        { period: cls.fromLabel }
      )
    );

    // 3. DB (última, transaccional).
    await applyDb(invoice, cls.periodId);

    return { ok: true, fromLabel: cls.fromLabel, toLabel: cls.toLabel };
  } catch (err) {
    let reverted = true;
    for (const comp of compensations.reverse()) {
      try {
        await comp();
      } catch {
        reverted = false;
      }
    }
    return { ok: false, error: err instanceof Error ? err.message : "Error", reverted };
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

/** Recorre las boletas; una fallida/salteada no aborta el resto. */
export async function moveInvoicesToNextPeriod(
  ctx: InvoiceMoveContext,
  clientId: string,
  invoiceIds: string[]
): Promise<BulkMoveSummary> {
  let moved = 0;
  const skipped: BulkMoveSummary["skipped"] = [];
  const failed: BulkMoveSummary["failed"] = [];

  for (const invoiceId of invoiceIds) {
    const r = await moveOneInvoiceToNextPeriod(ctx, clientId, invoiceId);
    if (r.ok) moved += 1;
    else if ("skip" in r) skipped.push({ invoiceId, reason: r.skip });
    else failed.push({ invoiceId, error: r.error, reverted: r.reverted });
  }

  return { moved, skipped, failed, total: invoiceIds.length };
}
