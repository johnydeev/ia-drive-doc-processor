import { loadEnv } from "@/lib/loadEnv";

async function runScheduler(): Promise<void> {
  loadEnv();

  const [
    envModule,
    runCycleModule,
    clientRepoModule,
    driveModule,
    controlModule,
    prismaModule,
    processingConfigModule,
  ] = await Promise.all([
    import("@/config/env"),
    import("@/jobs/runProcessingCycle"),
    import("@/repositories/client.repository"),
    import("@/services/googleDrive.service"),
    import("@/services/schedulerControl.service"),
    import("@/lib/prisma"),
    import("@/lib/clientProcessingConfig"),
  ]);

  const env = (envModule as { env: { PROCESS_INTERVAL_MINUTES: string } }).env;
  const { parseProcessIntervalMinutes } = runCycleModule as {
    parseProcessIntervalMinutes: (value: string) => number;
  };
  const { ClientRepository } = clientRepoModule as typeof import("@/repositories/client.repository");
  const { GoogleDriveService } = driveModule as {
    GoogleDriveService: new (googleConfig?: unknown) => {
      listPendingPdfFiles: (folderId: string) => Promise<Array<{ id: string; name: string }>>;
    };
  };
  const { SchedulerControlService } = controlModule as {
    SchedulerControlService: new () => {
      getState: (intervalMinutes: number, clientId?: string) => Promise<{ enabled: boolean }>;
      touchHeartbeat: (intervalMinutes: number, clientId?: string) => Promise<unknown>;
    };
  };
  const { getPrismaClient } = prismaModule as {
    getPrismaClient: () => {
      invoice: { findFirst: (args: unknown) => Promise<{ id: string } | null> };
      processingJob: {
        findFirst: (args: unknown) => Promise<{ id: string } | null>;
        create: (args: unknown) => Promise<unknown>;
      };
    };
  };
  const {
    resolveGoogleConfig,
    resolveSheetName,
    validateClientProcessingConfig,
  } = processingConfigModule as typeof import("@/lib/clientProcessingConfig");

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
          const prisma = getPrismaClient();
          await controlService.touchHeartbeat(minutes, client.id);
          const state = await controlService.getState(minutes, client.id);
          if (!state.enabled) {
            console.log(`[scheduler] client paused clientId=${client.id} name=\"${client.name}\"`);
            continue;
          }

          const sheetName = resolveSheetName(client);
          const googleConfig = resolveGoogleConfig(client);
          validateClientProcessingConfig(client, sheetName, googleConfig);

          const driveService = new GoogleDriveService(googleConfig);
          const files = await driveService.listPendingPdfFiles(client.driveFolderPending);
          if (files.length === 0) {
            continue;
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
              `[scheduler] queued ${created} job(s) for clientId=${client.id} name=\"${client.name}\"`
            );
          }
        } catch (error) {
          console.error(
            `[scheduler] job enqueue failed clientId=${client.id} name=\"${client.name}\" error=${
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
