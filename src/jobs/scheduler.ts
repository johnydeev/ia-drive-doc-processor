import { env } from "@/config/env";
import { parseProcessIntervalMinutes } from "@/jobs/runProcessingCycle";
import { ClientRepository } from "@/repositories/client.repository";
import { GoogleDriveService } from "@/services/googleDrive.service";
import { SchedulerControlService } from "@/services/schedulerControl.service";
import { getPrismaClient } from "@/lib/prisma";
import { schedulerLog } from "@/lib/logger";
import {
  resolveGoogleConfig,
  resolveSheetName,
  resolveFolders,
  validateClientProcessingConfig,
} from "@/lib/clientProcessingConfig";
import { SCHEDULER_TICK_MS, resolveClientIntervalMs, resolveBatchSize, shouldEvaluateClient } from "@/jobs/schedulerTiming";

const clientRepository = new ClientRepository();
const controlService = new SchedulerControlService();
// globalMinutes = intervalo POR DEFECTO por cliente (env). NO es el tick de polling:
// el tick es SCHEDULER_TICK_MS (fino) y cada cliente corre según su intervalMinutes
// (leído del DB en cada ciclo → cambiarlo en la DB toma efecto sin reiniciar).
const globalMinutes = parseProcessIntervalMinutes(env.PROCESS_INTERVAL_MINUTES);

/**
 * Jobs zombie: si el worker se reinicia a mitad de un job (crash, deploy), el
 * registro queda en PROCESSING para siempre y bloquea el re-encolado de ese
 * archivo. Una boleta real tarda segundos/minutos → un PROCESSING más viejo que
 * este umbral se considera muerto y se devuelve a PENDING (o FAILED si ya agotó
 * intentos). Visto en prod: 2 jobs PROCESSING desde mayo por crashes del worker.
 */
const STALE_JOB_MAX_AGE_MS = 30 * 60_000;
/** Debe coincidir con el default de ProcessingJob.maxAttempts en el schema. */
const STALE_JOB_FAILED_AFTER_ATTEMPTS = 3;

let localRunning = false;
const lastRunByClient = new Map<string, number>();

const runOnce = async (): Promise<void> => {
  if (localRunning) {
    schedulerLog.skippedBusy();
    return;
  }

  localRunning = true;

  try {
    const clients = await clientRepository.listActiveClients();
    if (clients.length === 0) {
      schedulerLog.cycleEmpty();
      return;
    }

    schedulerLog.cycleStart(clients.length);

    const now = Date.now();
    let totalFound = 0;
    let totalQueued = 0;
    let totalSkipped = 0;
    let totalAlreadyLoaded = 0;

    for (const client of clients) {
      // intervalMinutes viene del DB (listActiveClients lo re-lee cada ciclo).
      const clientIntervalMs = resolveClientIntervalMs(client.intervalMinutes, globalMinutes);
      const lastRun = lastRunByClient.get(client.id) ?? 0;
      if (!shouldEvaluateClient(now, lastRun, clientIntervalMs)) {
        continue;
      }
      // Marca la evaluación ANTES de trabajar: el throttle por intervalMinutes aplica
      // pase lo que pase (sin PDFs, pausado o error) → no se re-evalúa cada tick.
      lastRunByClient.set(client.id, now);
      try {
        const prisma = getPrismaClient();
        const clientMinutes = client.intervalMinutes > 0 ? client.intervalMinutes : globalMinutes;
        await controlService.touchHeartbeat(clientMinutes, client.id);
        const state = await controlService.getState(clientMinutes, client.id);

        if (!state.enabled) {
          schedulerLog.clientPaused(client.id, client.name);
          continue;
        }

        // Circuit breaker de cuota IA: si el worker detectó 429 en todos los
        // proveedores, hay una pausa con vencimiento (aiPausedUntil). Mientras
        // esté vigente no se escanea Drive ni se encola nada para el cliente;
        // al vencer (reset de cuota, medianoche del Pacífico) se reanuda sola.
        const quotaPause = await prisma.schedulerState.findFirst({
          where: { clientId: client.id, aiPausedUntil: { gt: new Date() } },
          select: { aiPausedUntil: true },
        });
        if (quotaPause?.aiPausedUntil) {
          schedulerLog.aiQuotaPaused(client.id, client.name, quotaPause.aiPausedUntil.toISOString());
          continue;
        }

        schedulerLog.clientScanning(client.id, client.name);

        const sheetName = resolveSheetName(client);
        const googleConfig = resolveGoogleConfig(client);
        const folders = resolveFolders(client);
        // Valida carpetas requeridas (incluida `statements`/Rendiciones). Si falta
        // alguna lanza → el catch loguea y saltea el cliente (cero tokens IA).
        validateClientProcessingConfig(client, sheetName, googleConfig);

        // "Llave" anti-tokens: sin ningún período ACTIVE no se encola nada. El
        // worker es el único que consume IA, así que cortar acá = 0 tokens.
        const activePeriods = await prisma.period.count({
          where: { clientId: client.id, status: "ACTIVE" },
        });
        if (activePeriods === 0) {
          schedulerLog.clientNoActivePeriods(client.id, client.name);
          continue;
        }

        // Recuperar jobs zombie (PROCESSING viejos de workers caídos): los que
        // agotaron intentos pasan a FAILED; el resto vuelve a PENDING para que
        // el worker los procese (la boleta no se pierde).
        const staleCutoff = new Date(now - STALE_JOB_MAX_AGE_MS);
        const staleFailed = await prisma.processingJob.updateMany({
          where: {
            clientId: client.id, status: "PROCESSING", startedAt: { lt: staleCutoff },
            attempts: { gte: STALE_JOB_FAILED_AFTER_ATTEMPTS - 1 },
          },
          data: { status: "FAILED", errorMessage: "Job zombie: el worker se reinició durante el procesamiento", finishedAt: new Date() },
        });
        const staleRequeued = await prisma.processingJob.updateMany({
          where: { clientId: client.id, status: "PROCESSING", startedAt: { lt: staleCutoff } },
          data: { status: "PENDING", startedAt: null, attempts: { increment: 1 } },
        });
        if (staleRequeued.count > 0 || staleFailed.count > 0) {
          schedulerLog.staleJobsRecovered(client.id, client.name, staleRequeued.count, staleFailed.count);
        }

        const driveService = new GoogleDriveService(googleConfig);
        const files = await driveService.listPendingPdfFiles(folders.pending);

        if (files.length === 0) {
          schedulerLog.clientNoPdfs(client.id, client.name);
          continue;
        }

        totalFound += files.length;

        const batchSize = resolveBatchSize(client.batchSize);
        let created = 0;
        for (const file of files) {
          const existingInvoice = await prisma.invoice.findFirst({
            where: { clientId: client.id, driveFileId: file.id },
            select: { id: true },
          });
          if (existingInvoice) {
            // Boleta YA cargada (tiene Invoice) pero el archivo sigue en
            // Pendientes (el move post-proceso falló, o el PDF fue devuelto a
            // la carpeta). Antes solo se salteaba → quedaba loopeando en
            // Pendientes para siempre y nunca se evaluaba como duplicado
            // (visto en prod: 14 archivos así). Se mueve a Duplicados (o
            // Escaneados) para destrabarlo. No se reprocesa ni se toca DB/Sheets.
            totalAlreadyLoaded += 1;
            const alreadyLoadedDest = folders.duplicates ?? folders.scanned;
            if (alreadyLoadedDest && alreadyLoadedDest !== folders.pending) {
              try {
                await driveService.moveFileToFolder(file.id, folders.pending, alreadyLoadedDest);
                schedulerLog.alreadyLoadedMoved(
                  client.id, client.name, file.name,
                  folders.duplicates ? "Duplicados" : "Escaneados"
                );
              } catch (moveError) {
                schedulerLog.clientError(
                  client.id, client.name,
                  `No se pudo mover boleta ya cargada "${file.name}": ${moveError instanceof Error ? moveError.message : "Unknown"}`
                );
              }
            }
            continue;
          }

          const existingJob = await prisma.processingJob.findFirst({
            where: {
              clientId: client.id,
              driveFileId: file.id,
              status: { in: ["PENDING", "PROCESSING"] },
            },
            select: { id: true },
          });
          if (existingJob) {
            totalSkipped += 1;
            continue;
          }

          await prisma.processingJob.create({
            data: {
              clientId: client.id,
              driveFileId: file.id,
              driveFileName: file.name,
              status: "PENDING",
            },
          });

          created += 1;
          totalQueued += 1;

          if (created >= batchSize) {
            schedulerLog.batchLimitReached(client.id, client.name, created, files.length);
            break;
          }
        }

        if (created > 0) {
          schedulerLog.jobsQueued(created, client.id, client.name, files.length, batchSize);
        }
      } catch (error) {
        schedulerLog.clientError(
          client.id,
          client.name,
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    }

    if (totalFound >= 1) {
      schedulerLog.cycleSummary({ totalFound, totalQueued, totalSkipped, totalAlreadyLoaded });
    }

    schedulerLog.cycleEnd();
  } catch (error) {
    schedulerLog.fatalError(error instanceof Error ? error.message : "Unknown error");
  } finally {
    localRunning = false;
  }
};

schedulerLog.starting(globalMinutes);

void runOnce();
setInterval(runOnce, SCHEDULER_TICK_MS);
