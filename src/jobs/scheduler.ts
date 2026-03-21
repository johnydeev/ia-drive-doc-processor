import { env } from "@/config/env";
import { parseProcessIntervalMinutes } from "@/jobs/runProcessingCycle";
import { ClientRepository } from "@/repositories/client.repository";
import { GoogleDriveService } from "@/services/googleDrive.service";
import { SchedulerControlService } from "@/services/schedulerControl.service";
import { getPrismaClient } from "@/lib/prisma";
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
    return;
  }

  localRunning = true;

  try {
    const clients = await clientRepository.listActiveClients();
    if (clients.length === 0) {
      console.log("[scheduler] no active clients to process");
      return;
    }

    for (const client of clients) {
      try {
        const prisma = getPrismaClient();
        await controlService.touchHeartbeat(minutes, client.id);
        const state = await controlService.getState(minutes, client.id);

        if (!state.enabled) {
          console.log(`[scheduler] client paused clientId=${client.id} name="${client.name}"`);
          continue;
        }

        const sheetName = resolveSheetName(client);
        const googleConfig = resolveGoogleConfig(client);
        const folders = resolveFolders(client);            // ← usa driveFoldersJson
        validateClientProcessingConfig(client, sheetName, googleConfig);

        const driveService = new GoogleDriveService(googleConfig);
        const files = await driveService.listPendingPdfFiles(folders.pending); // ← corregido

        if (files.length === 0) {
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
        }

        if (created > 0) {
          console.log(
            `[scheduler] queued ${created} job(s) for clientId=${client.id} name="${client.name}"`
          );
        }
      } catch (error) {
        console.error(
          `[scheduler] job enqueue failed clientId=${client.id} name="${client.name}" error=${
            error instanceof Error ? error.message : "Unknown error"
          }`
        );
      }
    }
  } catch (error) {
    console.error(
      "[scheduler] failed",
      error instanceof Error ? error.message : "Unknown error"
    );
  } finally {
    localRunning = false;
  }
};

console.log(`[scheduler] starting. Interval: ${minutes} minutes`);

void runOnce();
setInterval(runOnce, intervalMs);
