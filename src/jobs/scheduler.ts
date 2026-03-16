import dotenv from "dotenv";
import { env } from "@/config/env";
import { parseProcessIntervalMinutes } from "@/jobs/runProcessingCycle";
import { ClientRepository } from "@/repositories/client.repository";
import { GoogleDriveService } from "@/services/googleDrive.service";
import { SchedulerControlService } from "@/services/schedulerControl.service";
import { getPrismaClient } from "@/lib/prisma";
import {
  resolveGoogleConfig,
  resolveSheetName,
  validateClientProcessingConfig,
} from "@/lib/clientProcessingConfig";
import { ProcessingClient } from "@/types/client.types";

async function enqueueJobsForClient(
  client: ProcessingClient,
  intervalMinutes: number,
  controlService: SchedulerControlService
): Promise<void> {
  const prisma = getPrismaClient();

  await controlService.touchHeartbeat(intervalMinutes, client.id);
  const state = await controlService.getState(intervalMinutes, client.id);
  if (!state.enabled) {
    console.log(`[scheduler] client paused clientId=${client.id} name="${client.name}"`);
    return;
  }

  const sheetName = resolveSheetName(client);
  const googleConfig = resolveGoogleConfig(client);
  validateClientProcessingConfig(client, sheetName, googleConfig);

  const driveService = new GoogleDriveService(googleConfig);
  const files = await driveService.listPendingPdfFiles(client.driveFolderPending);
  if (files.length === 0) {
    return;
  }

  let created = 0;
  for (const file of files) {
    const existingInvoice = await prisma.invoice.findFirst({
      where: {
        clientId: client.id,
        driveFileId: file.id,
      },
      select: { id: true },
    });

    if (existingInvoice) {
      continue;
    }

    const existing = await prisma.processingJob.findFirst({
      where: {
        clientId: client.id,
        driveFileId: file.id,
      },
      select: { id: true },
    });

    if (existing) {
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
}

async function runScheduler(): Promise<void> {
  dotenv.config({ path: [".env.local", ".env"] });

  const clientRepository = new ClientRepository();
  const controlService = new SchedulerControlService();
  const minutes = parseProcessIntervalMinutes(env.PROCESS_INTERVAL_MINUTES);
  const intervalMs = minutes * 60 * 1000;

  let localRunning = false;

  const runOnce = async () => {
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
          await enqueueJobsForClient(client, minutes, controlService);
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
  await runOnce();

  setInterval(runOnce, intervalMs);
}

void runScheduler();
