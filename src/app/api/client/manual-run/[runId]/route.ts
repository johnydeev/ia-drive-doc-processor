import { NextRequest, NextResponse } from "next/server";
import { requireClientSession } from "@/lib/clientAuth";
import { getPrismaClient } from "@/lib/prisma";
import { DiagnosticsRunService } from "@/services/diagnosticsRun.service";
import { loadProcessingClient, resolveFolders, resolveGoogleConfig } from "@/lib/clientProcessingConfig";

/**
 * Estado de una corrida selectiva, para el progreso del modal.
 *
 * Cuando ya no queda ningún job en curso devuelve además el link al reporte. El
 * reporte lo escribe el worker; acá se consulta por si el modal llega antes de
 * que el worker haya terminado de subirlo (`finalizeIfComplete` es idempotente).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const auth = await requireClientSession(request);
  if (auth.error) return auth.error;

  const clientId = auth.session.clientId;
  const { runId } = await params;

  try {
    const prisma = getPrismaClient();
    const jobs = await prisma.processingJob.findMany({
      where: { clientId, diagnosticRunId: runId },
      orderBy: { createdAt: "asc" },
      select: {
        driveFileId: true, driveFileName: true, status: true,
        errorMessage: true, finishedAt: true, diagnosticsJson: true,
      },
    });

    if (jobs.length === 0) {
      return NextResponse.json({ ok: false, error: "Corrida no encontrada" }, { status: 404 });
    }

    const files = jobs.map((job) => {
      const diagnostics = job.diagnosticsJson as { result?: string; reason?: string | null } | null;
      return {
        fileId: job.driveFileId,
        fileName: job.driveFileName,
        status: job.status,
        result: diagnostics?.result ?? null,
        reason: diagnostics?.reason ?? null,
        errorMessage: job.errorMessage,
      };
    });

    const done = jobs.every((job) => job.status === "COMPLETED" || job.status === "FAILED");

    let report = null;
    if (done) {
      const client = await loadProcessingClient(clientId);
      if (client) {
        report = await new DiagnosticsRunService().finalizeIfComplete(
          runId,
          { id: client.id, name: client.name },
          resolveGoogleConfig(client),
          resolveFolders(client).pending
        );
      }
    }

    return NextResponse.json({ ok: true, runId, done, files, report });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
