import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { GoogleDriveService } from "@/services/googleDrive.service";
import { loadProcessingClient, resolveFolders, resolveGoogleConfig } from "@/lib/clientProcessingConfig";
import { buildManualRunList, MAX_MANUAL_RUN_FILES } from "@/lib/manualRun";

/**
 * Boletas disponibles para una corrida selectiva: los PDFs/imágenes de la carpeta
 * Pendientes, marcando cuáles ya tienen un job en curso o una boleta cargada.
 *
 * La decisión de qué se puede elegir vive en `lib/manualRun` (puro).
 */
export async function GET(request: NextRequest) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;

  const clientId = auth.session.clientId;

  try {
    const prisma = getPrismaClient();
    const client = await loadProcessingClient(clientId);
    if (!client) {
      return NextResponse.json({ ok: false, error: "Cliente no encontrado" }, { status: 404 });
    }

    const folders = resolveFolders(client);
    if (!folders.pending) {
      return NextResponse.json(
        { ok: false, error: "El cliente no tiene configurada la carpeta Pendientes" },
        { status: 400 }
      );
    }

    const drive = new GoogleDriveService(resolveGoogleConfig(client));
    const files = await drive.listPdfFilesInFolder(folders.pending);
    const fileIds = files.map((file) => file.id);

    const [jobs, invoices] = await Promise.all([
      prisma.processingJob.findMany({
        where: { clientId, driveFileId: { in: fileIds }, status: { in: ["PENDING", "PROCESSING"] } },
        select: { driveFileId: true },
      }),
      prisma.invoice.findMany({
        where: { clientId, driveFileId: { in: fileIds } },
        select: { driveFileId: true },
      }),
    ]);

    const list = buildManualRunList(
      files.map((file) => ({ id: file.id, name: file.name, mimeType: file.mimeType })),
      new Set(jobs.map((job) => job.driveFileId)),
      new Set(invoices.map((invoice) => invoice.driveFileId!).filter(Boolean))
    );

    return NextResponse.json({ ok: true, files: list, max: MAX_MANUAL_RUN_FILES });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
