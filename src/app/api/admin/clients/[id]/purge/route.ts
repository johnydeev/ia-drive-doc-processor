import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/adminAuth";
import { getPrismaClient } from "@/lib/prisma";
import { resolveGoogleConfig, resolveFolders, resolveSheetName } from "@/lib/clientProcessingConfig";
import { GoogleDriveService } from "@/services/googleDrive.service";
import { GoogleSheetsService } from "@/services/googleSheets.service";
import { ProcessingClient } from "@/types/client.types";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = requireAdminSession(request);
  if (auth.error) return auth.error;

  const { id } = await context.params;
  const prisma = getPrismaClient();

  const client = await prisma.client.findUnique({ where: { id }, select: { id: true, name: true } });
  if (!client) {
    return NextResponse.json({ ok: false, error: "Cliente no encontrado" }, { status: 404 });
  }

  const count = await prisma.invoice.count({ where: { clientId: id } });
  return NextResponse.json({ ok: true, count, clientName: client.name });
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = requireAdminSession(request);
  if (auth.error) return auth.error;

  const { id } = await context.params;
  const prisma = getPrismaClient();

  // 1. Obtener cliente con credenciales
  const client = await prisma.client.findUnique({
    where: { id },
    select: {
      id: true, name: true, isActive: true,
      driveFoldersJson: true, googleConfigJson: true, extractionConfigJson: true,
    },
  });
  if (!client) {
    return NextResponse.json({ ok: false, error: "Cliente no encontrado" }, { status: 404 });
  }

  // 2. Obtener todas las invoices
  const invoices = await prisma.invoice.findMany({
    where: { clientId: id },
    select: { id: true, driveFileId: true },
  });

  const totalCount = invoices.length;
  let driveMovedBack = 0;
  let driveFailed = 0;
  let sheetsCleared = true;

  const processingClient = client as unknown as ProcessingClient;

  // 3. Mover archivos de Drive de vuelta a pendientes
  const googleConfig = resolveGoogleConfig(processingClient);
  if (googleConfig) {
    const folders = resolveFolders(processingClient);
    if (folders.pending && folders.scanned) {
      try {
        const driveService = new GoogleDriveService(googleConfig);
        for (const invoice of invoices) {
          if (!invoice.driveFileId) continue;
          try {
            // Intentar mover desde scanned → pending
            await driveService.moveFileToFolder(invoice.driveFileId, folders.scanned, folders.pending);
            driveMovedBack++;
          } catch {
            // Si falla, intentar desde unassigned → pending
            if (folders.unassigned) {
              try {
                await driveService.moveFileToFolder(invoice.driveFileId, folders.unassigned, folders.pending);
                driveMovedBack++;
              } catch {
                driveFailed++;
                console.warn(`[purge] No se pudo mover archivo ${invoice.driveFileId} de vuelta a pendientes`);
              }
            } else {
              driveFailed++;
              console.warn(`[purge] No se pudo mover archivo ${invoice.driveFileId} (sin carpeta unassigned)`);
            }
          }
        }
      } catch (err) {
        console.warn(`[purge] Error inicializando Drive service:`, err);
        driveFailed = invoices.filter((i) => i.driveFileId).length;
      }
    } else {
      console.warn(`[purge] Cliente ${id} sin carpetas pending/scanned configuradas, skip Drive`);
    }
  } else {
    console.warn(`[purge] Cliente ${id} sin credenciales Google configuradas, skip Drive`);
  }

  // 4. Limpiar Google Sheets
  if (googleConfig) {
    try {
      const sheetsService = new GoogleSheetsService(googleConfig);
      const sheetName = resolveSheetName(processingClient);
      await sheetsService.clearAllDataRows(sheetName);
    } catch (err) {
      console.warn(`[purge] Error limpiando Sheets:`, err);
      sheetsCleared = false;
    }
  } else {
    console.warn(`[purge] Cliente ${id} sin config Google, skip Sheets`);
    sheetsCleared = false;
  }

  // 5. Borrar de DB y resetear métricas en transacción
  await prisma.$transaction(async (tx) => {
    await tx.processingJob.deleteMany({ where: { clientId: id } });
    await tx.invoice.deleteMany({ where: { clientId: id } });
    await tx.tokenUsage.deleteMany({ where: { clientId: id } });
    await tx.schedulerState.updateMany({
      where: { clientId: id },
      data: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        totalRuns: 0,
        totalFound: 0,
        totalProcessed: 0,
        totalSkipped: 0,
        totalFailed: 0,
        totalDuplicates: 0,
      },
    });
  });

  return NextResponse.json({
    ok: true,
    deleted: totalCount,
    driveMovedBack,
    driveFailed,
    sheetsCleared,
  });
}
