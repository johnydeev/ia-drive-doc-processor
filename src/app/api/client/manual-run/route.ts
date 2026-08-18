import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { GoogleDriveService } from "@/services/googleDrive.service";
import { loadProcessingClient, resolveFolders, resolveGoogleConfig } from "@/lib/clientProcessingConfig";
import { buildManualRunList, validateSelection } from "@/lib/manualRun";

/**
 * Encola una corrida selectiva: hasta 10 boletas elegidas a mano.
 *
 * NO procesa acá. El worker toma los jobs igual que los del scheduler —su bucle
 * filtra por `status: "PENDING"` y no mira el flag del scheduler—, así que esto
 * funciona con el scheduler prendido o apagado. Procesar dentro del request
 * habría metido ~85s en una conexión que el túnel corta a los 100s.
 *
 * Los jobs comparten un `diagnosticRunId`: es lo que hace que el worker capture
 * el diagnóstico y arme el reporte de Drive al terminar la última.
 */
export async function POST(request: NextRequest) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;

  const clientId = auth.session.clientId;

  try {
    const body = (await request.json()) as { fileIds?: unknown };
    const requested = Array.isArray(body.fileIds) ? body.fileIds.filter((id): id is string => typeof id === "string") : [];

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

    // La lista se rearma contra Drive y la DB: el tope y la disponibilidad se
    // validan en el server, no se confía en lo que mandó el modal.
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

    const selection = validateSelection(requested, list);
    if (!selection.ok) {
      return NextResponse.json({ ok: false, error: selection.error }, { status: 400 });
    }

    const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const byId = new Map(list.map((file) => [file.id, file]));

    await prisma.processingJob.createMany({
      data: selection.fileIds.map((fileId) => ({
        clientId,
        driveFileId: fileId,
        driveFileName: byId.get(fileId)?.name ?? null,
        status: "PENDING" as const,
        diagnosticRunId: runId,
      })),
    });

    return NextResponse.json({ ok: true, runId, queued: selection.fileIds.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
