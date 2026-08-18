import { env } from "@/config/env";
import { nextQuotaResetUtc } from "@/lib/quotaReset";
import { parseProcessIntervalMinutes } from "@/jobs/runProcessingCycle";
import { processSingleDriveFileJob } from "@/jobs/processPendingDocuments.job";
import { getPrismaClient } from "@/lib/prisma";
import { withDbRetry } from "@/lib/dbRetry";
import { workerLog } from "@/lib/logger";
import { DiagnosticsRunService } from "@/services/diagnosticsRun.service";
import type { BoletaDiagnostics } from "@/lib/diagnosticsReport";
import {
  resolveAiConfig,
  resolveGoogleConfig,
  resolveMapping,
  resolveSheetName,
  resolveFolders,
  validateClientProcessingConfig,
} from "@/lib/clientProcessingConfig";
import { ProcessingPersistenceService } from "@/services/processingPersistence.service";
import type { ClientDriveFolders, ProcessingClient } from "@/types/client.types";
import type { ProcessJobSummary } from "@/types/process.types";

const POLL_INTERVAL_MS = 2000;
const intervalMinutes = parseProcessIntervalMinutes(env.PROCESS_INTERVAL_MINUTES);
const persistence = new ProcessingPersistenceService();

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mapClient(row: {
  id: string;
  name: string;
  isActive: boolean;
  batchSize: number;
  intervalMinutes: number;
  driveFoldersJson: unknown;
  googleConfigJson: unknown;
  extractionConfigJson: unknown;
}): ProcessingClient {
  return {
    id: row.id,
    name: row.name,
    isActive: row.isActive,
    batchSize: row.batchSize,
    intervalMinutes: row.intervalMinutes,
    driveFoldersJson: (row.driveFoldersJson as ClientDriveFolders | null | undefined) ?? null,
    googleConfigJson: (row.googleConfigJson as ProcessingClient["googleConfigJson"]) ?? null,
    extractionConfigJson:
      (row.extractionConfigJson as ProcessingClient["extractionConfigJson"]) ?? null,
  };
}

async function claimNextJob() {
  return withDbRetry(
    async () => {
      const prisma = getPrismaClient();
      const job = await prisma.processingJob.findFirst({
        where: { status: "PENDING" },
        orderBy: { createdAt: "asc" },
      });

      if (!job) return null;

      const now = new Date();
      const updated = await prisma.processingJob.updateMany({
        where: { id: job.id, status: "PENDING" },
        data: { status: "PROCESSING", startedAt: now },
      });

      if (updated.count === 0) return null;

      return { ...job, status: "PROCESSING", startedAt: now };
    },
    { onRetry: (attempt, error) => workerLog.dbRetry("claim", attempt, errMessage(error)) }
  );
}

async function finalizeJob(
  jobId: string,
  fileName: string | null,
  attempts: number,
  maxAttempts: number,
  startedAt: Date | null,
  success: boolean,
  errorMessage?: string
): Promise<void> {
  const prisma = getPrismaClient();
  const now = new Date();
  const durationMs = startedAt ? now.getTime() - startedAt.getTime() : 0;

  if (success) {
    await withDbRetry(
      () =>
        prisma.processingJob.update({
          where: { id: jobId },
          data: { status: "COMPLETED", finishedAt: now, errorMessage: null },
        }),
      { onRetry: (attempt, error) => workerLog.dbRetry("finalize", attempt, errMessage(error)) }
    );
    workerLog.jobCompleted(jobId, fileName, durationMs);
    return;
  }

  const nextAttempts = attempts + 1;
  const shouldFail = nextAttempts >= maxAttempts;

  await withDbRetry(
    () =>
      prisma.processingJob.update({
        where: { id: jobId },
        data: {
          status: shouldFail ? "FAILED" : "PENDING",
          attempts: nextAttempts,
          errorMessage: errorMessage ?? "Unknown error",
          finishedAt: shouldFail ? now : null,
          startedAt: shouldFail ? startedAt : null,
        },
      }),
    { onRetry: (attempt, error) => workerLog.dbRetry("finalize", attempt, errMessage(error)) }
  );

  workerLog.jobFailed(jobId, fileName, errorMessage ?? "Unknown error", nextAttempts, maxAttempts);

  if (shouldFail) {
    workerLog.jobPermanentFailure(jobId, fileName);
  } else {
    workerLog.jobRetry(jobId, nextAttempts + 1, maxAttempts);
  }
}

async function handleJob(job: {
  id: string;
  clientId: string;
  driveFileId: string;
  driveFileName: string | null;
  attempts: number;
  maxAttempts: number;
  startedAt: Date | null;
  /** Corrida selectiva a la que pertenece este job (null = job del scheduler). */
  diagnosticRunId: string | null;
}): Promise<ProcessJobSummary | null> {
  const prisma = getPrismaClient();

  const clientRow = await withDbRetry(
    () =>
      prisma.client.findUnique({
        where: { id: job.clientId },
        select: {
          id: true,
          name: true,
          isActive: true,
          batchSize: true,
          intervalMinutes: true,
          driveFoldersJson: true,
          googleConfigJson: true,
          extractionConfigJson: true,
        },
      }),
    { onRetry: (attempt, error) => workerLog.dbRetry("client", attempt, errMessage(error)) }
  );

  if (!clientRow) {
    workerLog.clientNotFound(job.id, job.clientId);
    await finalizeJob(job.id, job.driveFileName, job.attempts, job.maxAttempts, job.startedAt, false, "Client not found");
    return null;
  }

  const client = mapClient(clientRow);

  if (!client.isActive) {
    workerLog.clientInactive(job.id, client.name);
    await finalizeJob(job.id, job.driveFileName, job.attempts, job.maxAttempts, job.startedAt, false, "Client inactive");
    return null;
  }

  workerLog.jobClaimed(job.id, job.driveFileId, job.driveFileName, client.name);

  let errorMessage: string | undefined;
  let summary: ProcessJobSummary | null = null;

  // Corrida selectiva: se captura el diagnóstico de la boleta para el reporte de
  // Drive. En los jobs normales del scheduler el colector no existe y el pipeline
  // corre exactamente igual que siempre.
  const diagnosticsService = job.diagnosticRunId ? new DiagnosticsRunService() : null;
  let diagnostics: BoletaDiagnostics | null = null;
  const onDiagnostics = diagnosticsService
    ? (payload: BoletaDiagnostics) => { diagnostics = payload; }
    : undefined;

  try {
    const sheetName = resolveSheetName(client);
    const mapping = resolveMapping(client);
    const googleConfig = resolveGoogleConfig(client);
    const folders = resolveFolders(client);
    validateClientProcessingConfig(client, sheetName, googleConfig);

    summary = await processSingleDriveFileJob(
      {
        clientId: client.id,
        clientName: client.name,
        sheetName,
        mapping,
        drivePendingFolderId: folders.pending,
        driveScannedFolderId: folders.scanned,
        driveUnassignedFolderId: folders.unassigned,
        driveFailedFolderId: folders.failed,
        driveProcessingFolderId: folders.processing,
        driveDuplicatesFolderId: folders.duplicates,
        driveStatementsFolderId: folders.statements,
        googleConfig,
        aiConfig: resolveAiConfig(client),
        debugMode: !!(client.extractionConfigJson as Record<string, unknown> | null)?.debugMode,
      },
      {
        id: job.driveFileId,
        name: job.driveFileName ?? job.driveFileId,
      },
      undefined,
      onDiagnostics
    );

    if (summary.failed > 0) {
      errorMessage = summary.errors[0]?.error ?? "Job failed";
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "Unknown error";
  }

  const success = summary !== null && summary.failed === 0;

  // El diagnóstico se guarda ANTES de cerrar el job: así, cuando el último job de
  // la corrida pase a COMPLETED, su dato ya está y el reporte sale completo.
  if (diagnosticsService && diagnostics) {
    try {
      await diagnosticsService.saveJobDiagnostics(job.id, diagnostics);
    } catch (error) {
      workerLog.unhandledError(job.id, `No se pudo guardar el diagnóstico: ${errMessage(error)}`);
    }
  }

  await finalizeJob(job.id, job.driveFileName, job.attempts, job.maxAttempts, job.startedAt, success, errorMessage);

  if (diagnosticsService && job.diagnosticRunId) {
    const links = await diagnosticsService.finalizeIfComplete(
      job.diagnosticRunId,
      { id: client.id, name: client.name },
      resolveGoogleConfig(client),
      resolveFolders(client).pending
    );
    if (links) {
      workerLog.diagnosticsReportReady(job.diagnosticRunId, links.markdownUrl ?? links.jsonUrl);
    }
  }

  // Circuit breaker de cuota IA: si la boleta se difirió por 429 en TODOS los
  // proveedores, pausar el ENCOLADO del cliente hasta el próximo reset de
  // cuota (medianoche del Pacífico). No toca el toggle manual `enabled`; la
  // pausa vence sola. Evita el churn de rebotes contra baldes vacíos.
  if (summary && (summary.rateLimited ?? 0) > 0) {
    try {
      const until = nextQuotaResetUtc();
      await prisma.schedulerState.updateMany({
        where: { clientId: client.id },
        data: { aiPausedUntil: until },
      });
      workerLog.aiQuotaPauseSet(client.name, until.toISOString());
    } catch {
      // No crítico: si falla, el rebote suave (1 boleta/intervalo) sigue siendo el fallback.
    }
  }

  if (summary) {
    const now = new Date();
    await persistence.recordClientRun({
      clientId: client.id,
      trigger: "schedule",
      intervalMinutes,
      enabled: true,
      startedAt: job.startedAt ?? now,
      endedAt: now,
      summary,
      errorMessage: success ? undefined : errorMessage,
    });
  }

  return summary;
}

/**
 * Heartbeat idle: loguear "cola vacía" como mucho cada N min (no cada poll de 2s).
 * Configurable vía WORKER_HEARTBEAT_MINUTES (opcional, default 30). Piso de 1 min
 * para evitar spamear si alguien lo setea en 0/negativo. Solo afecta el log de
 * vida — el polling (2s) y el procesamiento de jobs no cambian.
 */
const IDLE_HEARTBEAT_MINUTES = Math.max(1, Number(env.WORKER_HEARTBEAT_MINUTES) || 30);
const IDLE_HEARTBEAT_MS = IDLE_HEARTBEAT_MINUTES * 60_000;

async function runWorker(): Promise<void> {
  workerLog.starting();

  let cycleProcessed = 0;
  let cycleFailed = 0;
  let cycleUnassigned = 0;
  let cycleSkipped = 0;
  let lastIdleLogAt = Date.now();

  while (true) {
    // Blindaje: un hipo de conexión a la DB (p. ej. el pooler de Supabase cierra
    // una conexión idle → P1017 "Server has closed the connection") NO debe tumbar
    // el worker. Antes `claimNextJob()` estaba fuera del try/catch y un error de DB
    // crasheaba el proceso (Docker lo reiniciaba en loop). Ahora se loguea, se
    // espera y se reintenta en el próximo ciclo (Prisma reconecta solo).
    let job: Awaited<ReturnType<typeof claimNextJob>>;
    try {
      job = await claimNextJob();
    } catch (error) {
      workerLog.unhandledError(
        "claim",
        error instanceof Error ? error.message : "Unknown error"
      );
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (!job) {
      if (cycleProcessed + cycleFailed + cycleUnassigned > 0) {
        workerLog.cycleSummary({
          processed: cycleProcessed,
          failed: cycleFailed,
          unassigned: cycleUnassigned,
          duplicates: cycleSkipped,
        });
        cycleProcessed = 0;
        cycleFailed = 0;
        cycleUnassigned = 0;
        cycleSkipped = 0;
      }
      if (Date.now() - lastIdleLogAt >= IDLE_HEARTBEAT_MS) {
        workerLog.idleHeartbeat();
        lastIdleLogAt = Date.now();
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Profundidad de cola: distingue al instante "worker hambriento" (0 detrás →
    // el límite es el scheduler/batchSize) de "cola atascada" (crece → el límite
    // es el worker). No crítico: si el count falla, se sigue igual.
    try {
      const pendingBehind = await getPrismaClient().processingJob.count({
        where: { status: "PENDING" },
      });
      workerLog.queueDepth(pendingBehind);
    } catch {
      // ignorar — es solo telemetría
    }

    try {
      const summary = await handleJob(job);
      if (summary) {
        cycleProcessed += summary.processed ?? 0;
        cycleFailed += summary.failed ?? 0;
        cycleUnassigned += summary.unassigned ?? 0;
        cycleSkipped += summary.duplicatesDetected ?? 0;
      }
    } catch (error) {
      workerLog.unhandledError(
        job.id,
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  }
}

void runWorker();
