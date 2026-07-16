import { getPrismaClient } from "@/lib/prisma";
import { GoogleDriveService } from "@/services/googleDrive.service";
import {
  GoogleSheetsService,
  SheetsRowMapping,
  type SheetRowIndex,
  findRowInIndex,
  adjustIndexAfterDelete,
} from "@/services/googleSheets.service";
import {
  DEFAULT_SHEETS_MAPPING,
  loadProcessingClient,
  resolveGoogleConfig,
  resolveMapping,
  resolveSheetName,
  resolveFolders,
  ResolvedFolders,
} from "@/lib/clientProcessingConfig";

/**
 * Flujo de borrado de boletas, extraído del endpoint por-consorcio para que el
 * borrado masivo (vista global de boletas entrantes) lo reutilice sin duplicar
 * la lógica de Drive/Sheets/DB.
 *
 * `destination` define a dónde va el PDF en Drive:
 *  - "failed"  → Revisión (no se reprocesa). Comportamiento del borrado por
 *    consorcio: la fila se borra pero el archivo queda para inspección manual.
 *  - "pending" → Pendientes (se reprocesa). Para la vista global: al borrar la
 *    Invoice + la fila del Sheet, no queda duplicado → el worker la procesa de
 *    nuevo (ideal para corregir boletas mal procesadas).
 */
export type InvoiceDeleteDestination = "pending" | "failed";

export interface InvoiceDeleteResult {
  ok: boolean;
  status: number;
  error?: string;
  warning?: string;
}

// Re-export para los importadores existentes (invoicePeriodMove, tests). La
// fuente única del mapping vive en clientProcessingConfig.
export { DEFAULT_SHEETS_MAPPING };

/**
 * Contexto compartido (config Google del cliente + servicios). Se resuelve UNA
 * vez y se reutiliza para borrar muchas boletas sin re-cargar el cliente ni
 * re-instanciar servicios por cada una.
 */
export interface InvoiceDeletionContext {
  driveService: GoogleDriveService;
  sheetsService: GoogleSheetsService;
  folders: ResolvedFolders;
  sheetName: string;
  mapping: SheetsRowMapping;
}

export async function resolveDeletionContext(
  clientId: string
): Promise<{ ctx: InvoiceDeletionContext } | { error: string; status: number }> {
  const processingClient = await loadProcessingClient(clientId);
  if (!processingClient) return { error: "Cliente no encontrado", status: 404 };

  const googleConfig = resolveGoogleConfig(processingClient);
  if (!googleConfig) return { error: "Sin credenciales de Google configuradas", status: 400 };

  return {
    ctx: {
      driveService: new GoogleDriveService(googleConfig),
      sheetsService: new GoogleSheetsService(googleConfig),
      folders: resolveFolders(processingClient),
      sheetName: resolveSheetName(processingClient),
      mapping: resolveMapping(processingClient) ?? DEFAULT_SHEETS_MAPPING,
    },
  };
}

/**
 * Borra una boleta: mueve el PDF al destino, borra recibo, fila de Sheets y DB.
 * La fila de Sheets se ubica en el `rowIndex` pre-cargado del lote (1 lectura de
 * hoja por lote, no por boleta); tras borrarla, el índice se ajusta para que las
 * boletas siguientes del lote apunten a la fila correcta (shift-up).
 */
export async function deleteOneInvoice(
  ctx: InvoiceDeletionContext,
  clientId: string,
  invoiceId: string,
  destination: InvoiceDeleteDestination,
  rowIndex: SheetRowIndex
): Promise<InvoiceDeleteResult> {
  const prisma = getPrismaClient();

  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, clientId },
    include: {
      _count: { select: { payments: true } },
      receipt: { select: { id: true, driveFileId: true } },
    },
  });
  if (!invoice) return { ok: false, status: 404, error: "Boleta no encontrada" };

  if (invoice._count.payments > 0) {
    return {
      ok: false,
      status: 409,
      error: `No se puede eliminar: la boleta tiene ${invoice._count.payments} pago(s) registrado(s). Eliminá los pagos primero.`,
    };
  }

  const destFolder = destination === "pending" ? ctx.folders.pending : ctx.folders.failed;
  let warning: string | undefined;

  // Mover el PDF desde su parent real (Rendiciones/Escaneados/etc.) al destino.
  if (invoice.driveFileId && destFolder) {
    try {
      const parents = await ctx.driveService.getFileParents(invoice.driveFileId);
      const fromFolderId =
        parents.find((p) => p === ctx.folders.scanned) ??
        parents.find((p) => p === ctx.folders.unassigned) ??
        parents.find((p) => p === ctx.folders.failed) ??
        parents.find((p) => p === ctx.folders.pending) ??
        parents[0];
      if (fromFolderId && fromFolderId !== destFolder) {
        await ctx.driveService.moveFileToFolder(invoice.driveFileId, fromFolderId, destFolder);
      }
    } catch (err) {
      return { ok: false, status: 502, error: `Drive falló al mover el archivo: ${err instanceof Error ? err.message : "Error"}` };
    }
  } else if (invoice.driveFileId && !destFolder) {
    warning = `Sin carpeta '${destination}' configurada — el archivo de Drive quedó donde estaba.`;
  }

  // Recibo manual → papelera.
  if (invoice.receipt?.driveFileId) {
    try {
      await ctx.driveService.trashFile(invoice.receipt.driveFileId);
    } catch (err) {
      return { ok: false, status: 502, error: `Drive falló al borrar el recibo: ${err instanceof Error ? err.message : "Error"}` };
    }
  }

  // Fila de Sheets: buscar en el índice del lote (sin re-leer la hoja).
  try {
    const rowNumber = findRowInIndex(rowIndex, {
      boletaNumber: invoice.boletaNumber,
      sourceFileUrl: invoice.sourceFileUrl,
      providerTaxId: invoice.providerTaxId,
    });
    if (rowNumber >= 2) {
      const deleted = await ctx.sheetsService.deleteRowAtNumber(ctx.sheetName, rowNumber);
      if (deleted) adjustIndexAfterDelete(rowIndex, rowNumber);
    }
    // rowNumber -1: la fila no está en la hoja (desincronización previa) → se sigue
    // igual que antes (deleteInvoiceRow devolvía false sin cortar el borrado).
  } catch (err) {
    return { ok: false, status: 502, error: `Sheets falló al borrar la fila: ${err instanceof Error ? err.message : "Error"}` };
  }

  // DB (Invoice + Receipt) en transacción.
  await prisma.$transaction(async (tx) => {
    if (invoice.receipt) await tx.receipt.delete({ where: { id: invoice.receipt.id } });
    // La obligación de gasto fijo vinculada vuelve a PENDING (si la boleta se
    // reprocesa, se re-vincula sola en el pipeline).
    await tx.expenseObligation.updateMany({
      where: { invoiceId },
      data: { status: "PENDING", invoiceId: null },
    });
    await tx.invoice.delete({ where: { id: invoiceId } });
  });

  return { ok: true, status: 200, warning };
}

/**
 * Borra un lote de boletas cargando el índice de la hoja UNA sola vez.
 * Una boleta fallida no aborta el resto. Devuelve un resultado por invoiceId
 * en el mismo orden de entrada.
 */
export async function deleteInvoicesWithIndex(
  ctx: InvoiceDeletionContext,
  clientId: string,
  invoiceIds: string[],
  destination: InvoiceDeleteDestination
): Promise<InvoiceDeleteResult[]> {
  const rowIndex = await ctx.sheetsService.loadRowIndex(ctx.sheetName, ctx.mapping);
  const results: InvoiceDeleteResult[] = [];
  for (const invoiceId of invoiceIds) {
    results.push(await deleteOneInvoice(ctx, clientId, invoiceId, destination, rowIndex));
  }
  return results;
}

/** Conveniencia: resuelve el contexto y borra una sola boleta. */
export async function deleteInvoiceById(
  clientId: string,
  invoiceId: string,
  destination: InvoiceDeleteDestination
): Promise<InvoiceDeleteResult> {
  const resolved = await resolveDeletionContext(clientId);
  if ("error" in resolved) return { ok: false, status: resolved.status, error: resolved.error };
  const [result] = await deleteInvoicesWithIndex(resolved.ctx, clientId, [invoiceId], destination);
  return result;
}
