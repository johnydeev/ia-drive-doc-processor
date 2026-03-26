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

const clientRepository = new ClientRepository();
const controlService = new SchedulerControlService();
const minutes = parseProcessIntervalMinutes(env.PROCESS_INTERVAL_MINUTES);
const intervalMs = minutes * 60 * 1000;

let localRunning = false;

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

    for (const client of clients) {
      try {
        const prisma = getPrismaClient();
        await controlService.touchHeartbeat(minutes, client.id);
        const state = await controlService.getState(minutes, client.id);

        if (!state.enabled) {
          schedulerLog.clientPaused(client.id, client.name);
          continue;
        }

        schedulerLog.clientScanning(client.id, client.name);

        const sheetName = resolveSheetName(client);
        const googleConfig = resolveGoogleConfig(client);
        const folders = resolveFolders(client);
        validateClientProcessingConfig(client, sheetName, googleConfig);

        const driveService = new GoogleDriveService(googleConfig);
        const files = await driveService.listPendingPdfFiles(folders.pending);

        if (files.length === 0) {
          schedulerLog.clientNoPdfs(client.id, client.name);
          continue;
        }

        let created = 0;
        for (const file of files) {
          const existingInvoice = await prisma.invoice.findFirst({
            where: { clientId: client.id, driveFileId: file.id },
            select: { id: true },
          });
          if (existingInvoice) {
            continue;
          }

          const existingJob = await prisma.processingJob.findFirst({
            where: { clientId: client.id, driveFileId: file.id },
            select: { id: true },
          });
          if (existingJob) {
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

          if (created >= client.batchSize) {
            schedulerLog.batchLimitReached(client.id, client.name, created, files.length);
            break;
          }
        }

        if (created > 0) {
          schedulerLog.jobsQueued(created, client.id, client.name);
        }
      } catch (error) {
        schedulerLog.clientError(
          client.id,
          client.name,
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    }

    schedulerLog.cycleEnd();
  } catch (error) {
    schedulerLog.fatalError(error instanceof Error ? error.message : "Unknown error");
  } finally {
    localRunning = false;
  }
};

schedulerLog.starting(minutes);

void runOnce();
setInterval(runOnce, intervalMs);
