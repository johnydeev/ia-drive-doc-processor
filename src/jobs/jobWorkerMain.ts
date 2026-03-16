import dotenv from "dotenv";
import { env } from "@/config/env";
import { parseProcessIntervalMinutes } from "@/jobs/runProcessingCycle";
import { processSingleDriveFileJob } from "@/jobs/processPendingDocuments.job";
import { getPrismaClient } from "@/lib/prisma";
import {
  resolveAiConfig,
  resolveGoogleConfig,
  resolveMapping,
  resolveSheetName,
  validateClientProcessingConfig,
} from "@/lib/clientProcessingConfig";
import { ProcessingPersistenceService } from "@/services/processingPersistence.service";
import { ProcessingClient } from "@/types/client.types";
import { ProcessJobSummary } from "@/types/process.types";

const POLL_INTERVAL_MS = 2000;

function mapClient(row: {
  id: string;
  name: string;
  isActive: boolean;
  driveFolderPending: string | null;
  driveFolderProcessed: string | null;
  googleConfigJson: unknown;
  extractionConfigJson: unknown;
}): ProcessingClient {
  return {
    id: row.id,
    name: row.name,
    isActive: row.isActive,
    driveFolderPending: row.driveFolderPending ?? "",
    driveFolderProcessed: row.driveFolderProcessed ?? "",
    googleConfigJson: (row.googleConfigJson as ProcessingClient["googleConfigJson"]) ?? null,
    extractionConfigJson:
      (row.extractionConfigJson as Record<string, unknown> | null | undefined) ?? null,
  };
}

async function claimNextJob() {
  const prisma = getPrismaClient();
  const job = await prisma.processingJob.findFirst({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
  });

  if (!job) {
    return null;
  }

  const now = new Date();
  const updated = await prisma.processingJob.updateMany({
    where: { id: job.id, status: "PENDING" },
    data: { status: "PROCESSING", startedAt: now },
  });

  if (updated.count === 0) {
    return null;
  }

  return { ...job, status: "PROCESSING", startedAt: now };
}

async function handleJob(job: {
  id: string;
  clientId: string;
  driveFileId: string;
  driveFileName: string | null;
  attempts: number;
  maxAttempts: number;
  startedAt: Date | null;
}) {
  const prisma = getPrismaClient();
  const persistence = new ProcessingPersistenceService();

  const clientRow = await prisma.client.findUnique({
    where: { id: job.clientId },
    select: {
      id: true,
      name: true,
      isActive: true,
      driveFolderPending: true,
      driveFolderProcessed: true,
      googleConfigJson: true,
      extractionConfigJson: true,
    },
  });

  if (!clientRow) {
    await prisma.processingJob.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorMessage: "Client not found",
      },
    });
    return;
  }

  const client = mapClient(clientRow);
  if (!client.isActive) {
    await prisma.processingJob.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorMessage: "Client inactive",
      },
    });
    return;
  }

  let errorMessage: string | undefined;
  let summary: ProcessJobSummary | null = null;

  try {
    const sheetName = resolveSheetName(client);
    const mapping = resolveMapping(client);
    const googleConfig = resolveGoogleConfig(client);
    validateClientProcessingConfig(client, sheetName, googleConfig);

    summary = await processSingleDriveFileJob(
      {
        clientId: client.id,
        clientName: client.name,
        sheetName,
        mapping,
        drivePendingFolderId: client.driveFolderPending,
        driveScannedFolderId: client.driveFolderProcessed,
        googleConfig,
        aiConfig: resolveAiConfig(client),
      },
      {
        id: job.driveFileId,
        name: job.driveFileName ?? job.driveFileId,
      }
    );

    if (summary.failed > 0) {
      errorMessage = summary.errors[0]?.error ?? "Job failed";
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : "Unknown error";
  }

  const now = new Date();
  const intervalMinutes = parseProcessIntervalMinutes(env.PROCESS_INTERVAL_MINUTES);

  if (!summary) {
    const nextAttempts = job.attempts + 1;
    const shouldFail = nextAttempts >= job.maxAttempts;

    await prisma.processingJob.update({
      where: { id: job.id },
      data: {
        status: shouldFail ? "FAILED" : "PENDING",
        attempts: nextAttempts,
        errorMessage: errorMessage ?? "Unknown error",
        finishedAt: shouldFail ? now : null,
        startedAt: shouldFail ? job.startedAt : null,
      },
    });

    return;
  }

  const success = summary.failed === 0;
  if (success) {
    await prisma.processingJob.update({
      where: { id: job.id },
      data: {
        status: "COMPLETED",
        finishedAt: now,
        errorMessage: null,
      },
    });
  } else {
    const nextAttempts = job.attempts + 1;
    const shouldFail = nextAttempts >= job.maxAttempts;

    await prisma.processingJob.update({
      where: { id: job.id },
      data: {
        status: shouldFail ? "FAILED" : "PENDING",
        attempts: nextAttempts,
        errorMessage: errorMessage ?? "Job failed",
        finishedAt: shouldFail ? now : null,
        startedAt: shouldFail ? job.startedAt : null,
      },
    });
  }

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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWorker(): Promise<void> {
  dotenv.config({ path: [".env.local", ".env"] });

  console.log("[job-worker] starting");

  while (true) {
    const job = await claimNextJob();
    if (!job) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    try {
      await handleJob(job);
    } catch (error) {
      console.error(
        `[job-worker] unhandled error jobId=${job.id} error=${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }
  }
}

void runWorker();
