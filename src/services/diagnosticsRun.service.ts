import { getPrismaClient } from "@/lib/prisma";
import { GoogleDriveService } from "@/services/googleDrive.service";
import { workerLog } from "@/lib/logger";
import {
  buildDiagnosticsJson,
  buildDiagnosticsMarkdown,
  diagnosticsFileName,
  type BoletaDiagnostics,
} from "@/lib/diagnosticsReport";
import type { ClientGoogleConfig } from "@/types/client.types";
import type { Prisma } from "@prisma/client";

/** Nombre de la subcarpeta de reportes dentro de Pendientes. */
export const DIAGNOSTICS_FOLDER_NAME = "_diagnosticos";

export interface DiagnosticsReportLinks {
  jsonUrl: string | null;
  markdownUrl: string | null;
}

/**
 * Diagnóstico de las corridas selectivas: guarda lo capturado por boleta y, cuando
 * la corrida termina, consolida el reporte en Drive.
 *
 * El armado de los archivos es lógica pura (`lib/diagnosticsReport`); acá vive
 * solo el acceso a DB y a Drive.
 */
export class DiagnosticsRunService {
  /** Guarda el diagnóstico de una boleta en su job, para consolidarlo al final. */
  async saveJobDiagnostics(jobId: string, payload: BoletaDiagnostics): Promise<void> {
    const prisma = getPrismaClient();
    await prisma.processingJob.update({
      where: { id: jobId },
      data: { diagnosticsJson: payload as unknown as Prisma.JsonObject },
    });
  }

  /**
   * Si ya no quedan jobs de la corrida en curso, arma el reporte y lo sube a la
   * subcarpeta `_diagnosticos` de Pendientes. Devuelve `null` si todavía falta
   * alguna boleta.
   *
   * Es idempotente: antes de subir chequea si el archivo ya existe. Ese chequeo
   * —y no un flag en la DB— es lo que evita el reporte duplicado, porque el
   * nombre incluye el id de la corrida.
   */
  async finalizeIfComplete(
    runId: string,
    client: { id: string; name: string },
    googleConfig: ClientGoogleConfig | null,
    pendingFolderId: string | undefined
  ): Promise<DiagnosticsReportLinks | null> {
    const prisma = getPrismaClient();

    const pending = await prisma.processingJob.count({
      where: { diagnosticRunId: runId, status: { in: ["PENDING", "PROCESSING"] } },
    });
    if (pending > 0) return null;

    const jobs = await prisma.processingJob.findMany({
      where: { diagnosticRunId: runId },
      orderBy: { createdAt: "asc" },
      select: { diagnosticsJson: true, createdAt: true, finishedAt: true },
    });
    if (jobs.length === 0) return null;

    const items = jobs
      .map((job) => job.diagnosticsJson as unknown as BoletaDiagnostics | null)
      .filter((item): item is BoletaDiagnostics => Boolean(item));

    const startedAt = jobs[0].createdAt;
    const finishedAt = jobs.reduce<Date>(
      (latest, job) => (job.finishedAt && job.finishedAt > latest ? job.finishedAt : latest),
      startedAt
    );
    const run = { runId, clientName: client.name, startedAt, finishedAt };

    if (!pendingFolderId) {
      workerLog.unhandledError(runId, "Sin carpeta Pendientes configurada: no se sube el reporte de diagnóstico");
      return { jsonUrl: null, markdownUrl: null };
    }

    try {
      const drive = new GoogleDriveService(googleConfig);
      const folderId = await drive.getOrCreateFolder(DIAGNOSTICS_FOLDER_NAME, pendingFolderId);
      const baseName = diagnosticsFileName(startedAt, runId);

      // Idempotencia: si el reporte de esta corrida ya está, no se vuelve a subir.
      const existing = await drive.listAllFilesInPending(folderId);
      if (existing.some((file) => file.name.startsWith(baseName))) {
        const json = existing.find((f) => f.name === `${baseName}.json`);
        const md = existing.find((f) => f.name === `${baseName}.md`);
        return {
          jsonUrl: json ? `https://drive.google.com/file/d/${json.id}/view` : null,
          markdownUrl: md ? `https://drive.google.com/file/d/${md.id}/view` : null,
        };
      }

      const jsonFile = await drive.uploadFile(
        Buffer.from(buildDiagnosticsJson(run, items), "utf-8"),
        `${baseName}.json`,
        "application/json",
        folderId
      );
      const mdFile = await drive.uploadFile(
        Buffer.from(buildDiagnosticsMarkdown(run, items), "utf-8"),
        `${baseName}.md`,
        "text/markdown",
        folderId
      );

      return {
        jsonUrl: jsonFile.webViewLink ?? `https://drive.google.com/file/d/${jsonFile.id}/view`,
        markdownUrl: mdFile.webViewLink ?? `https://drive.google.com/file/d/${mdFile.id}/view`,
      };
    } catch (error) {
      // El reporte es una ayuda de diagnóstico: que falle su subida NO puede
      // arrastrar al procesamiento, que ya terminó bien.
      workerLog.unhandledError(
        runId,
        `No se pudo subir el reporte de diagnóstico: ${error instanceof Error ? error.message : "Unknown"}`
      );
      return { jsonUrl: null, markdownUrl: null };
    }
  }
}
