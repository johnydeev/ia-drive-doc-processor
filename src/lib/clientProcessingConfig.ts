import { env } from "@/config/env";
import { getPrismaClient } from "@/lib/prisma";
import { SheetsRowMapping } from "@/services/googleSheets.service";
import {
  ClientDriveFolders,
  ClientExtractionConfig,
  ClientGoogleConfig,
  ProcessingClient,
} from "@/types/client.types";
import { decrypt } from "@/utils/encryption.util";

/**
 * Carga un cliente desde la DB y lo mapea a `ProcessingClient`.
 *
 * Reemplaza el patrón duplicado en ~7 rutas que hacían el mismo
 * `findUnique({ select: { driveFoldersJson, googleConfigJson, extractionConfigJson } })`
 * + mapeo manual, varias con valores hardcodeados inconsistentes
 * (`name: ""`, `batchSize: 10`, `intervalMinutes: 60`). Acá se traen los
 * valores reales del cliente. Retorna null si el cliente no existe.
 */
export async function loadProcessingClient(
  clientId: string
): Promise<ProcessingClient | null> {
  const prisma = getPrismaClient();
  const row = await prisma.client.findUnique({
    where: { id: clientId },
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
  });

  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    isActive: row.isActive,
    batchSize: row.batchSize,
    intervalMinutes: row.intervalMinutes,
    driveFoldersJson: (row.driveFoldersJson as ClientDriveFolders | null | undefined) ?? null,
    googleConfigJson: (row.googleConfigJson as ClientGoogleConfig | null | undefined) ?? null,
    extractionConfigJson:
      (row.extractionConfigJson as ClientExtractionConfig | null | undefined) ?? null,
  };
}

export function resolveSheetName(client: ProcessingClient): string {
  const fromConfig = client.extractionConfigJson?.sheetName;
  if (typeof fromConfig === "string" && fromConfig.trim().length > 0) {
    return fromConfig.trim();
  }

  return env.GOOGLE_SHEETS_SHEET_NAME;
}

export function resolveMapping(client: ProcessingClient): SheetsRowMapping | undefined {
  const raw = client.extractionConfigJson?.columnMapping;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const requiredKeys: Array<keyof SheetsRowMapping> = [
    "boletaNumber",
    "provider",
    "consortium",
    "providerTaxId",
    "detail",
    "observation",
    "dueDate",
    "amount",
    "alias",
    "clientNumber",
    "sourceFileUrl",
    "isDuplicate",
    "period",
    "paymentStatus",
    "bank",
    "remainingBalance",
    "paidAmount",
    "installmentsCount",
    "paymentDate",
    "receiptUrl",
    "paidWith",
  ];

  const parsed = raw as Record<string, unknown>;
  for (const key of requiredKeys) {
    if (typeof parsed[key] !== "string" || parsed[key].trim().length === 0) {
      return undefined;
    }
  }

  return parsed as unknown as SheetsRowMapping;
}

export function resolveGoogleConfig(client: ProcessingClient): ClientGoogleConfig | null {
  const raw = client.googleConfigJson;
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const projectId = asRequiredString(raw.projectId);
  const clientEmail = asRequiredString(raw.clientEmail);
  const privateKeyRaw = asRequiredString(raw.privateKey);
  const sheetsId = asRequiredString(raw.sheetsId);
  // Email a impersonar (domain-wide delegation). Plano, no cifrado.
  const impersonateEmail = asOptionalString(raw.impersonateEmail);

  if (!projectId || !clientEmail || !privateKeyRaw || !sheetsId) {
    return null;
  }

  return {
    projectId,
    clientEmail,
    privateKey: decrypt(privateKeyRaw),
    sheetsId,
    ...(impersonateEmail ? { impersonateEmail } : {}),
  };
}

export function resolveAiConfig(client: ProcessingClient): {
  geminiApiKey?: string;
  geminiModel?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  anthropicApiKey?: string;
  anthropicModel?: string;
} | null {
  const raw = client.extractionConfigJson;
  if (!raw || typeof raw !== "object") {
    return null;
  }

  // Las API keys se guardan cifradas — hay que descifrarlas antes de usarlas
  const geminiApiKeyRaw = asOptionalString(raw.geminiApiKey);
  const openaiApiKeyRaw = asOptionalString(raw.openaiApiKey);
  const anthropicApiKeyRaw = asOptionalString(raw.anthropicApiKey);
  const geminiModel = asOptionalString(raw.geminiModel);
  const openaiModel = asOptionalString(raw.openaiModel);
  const anthropicModel = asOptionalString(raw.anthropicModel);

  const geminiApiKey = geminiApiKeyRaw ? decrypt(geminiApiKeyRaw) : undefined;
  const openaiApiKey = openaiApiKeyRaw ? decrypt(openaiApiKeyRaw) : undefined;
  const anthropicApiKey = anthropicApiKeyRaw ? decrypt(anthropicApiKeyRaw) : undefined;

  if (!geminiApiKey && !openaiApiKey && !anthropicApiKey && !geminiModel && !openaiModel && !anthropicModel) {
    return null;
  }

  return { geminiApiKey, geminiModel, openaiApiKey, openaiModel, anthropicApiKey, anthropicModel };
}

export interface ResolvedFolders {
  pending: string;
  scanned: string;
  unassigned: string | null;
  failed: string | null;
  receipts: string | null;
  processing: string | null;
  duplicates: string | null;
  statements: string | null;
}

export function resolveFolders(client: ProcessingClient): ResolvedFolders {
  const f = client.driveFoldersJson as ClientDriveFolders | null | undefined;

  return {
    pending:    f?.pending?.trim()    || env.GOOGLE_DRIVE_PENDING_FOLDER_ID  || "",
    scanned:    f?.scanned?.trim()    || env.GOOGLE_DRIVE_SCANNED_FOLDER_ID  || "",
    unassigned: f?.unassigned?.trim() || null,
    failed:     f?.failed?.trim()     || null,
    receipts:   f?.receipts?.trim()   || null,
    processing: f?.processing?.trim() || null,
    duplicates: f?.duplicates?.trim() || null,
    statements: f?.statements?.trim() || null,
  };
}

export function validateClientProcessingConfig(
  client: ProcessingClient,
  sheetName: string,
  googleConfig: ClientGoogleConfig | null
): void {
  const folders = resolveFolders(client);

  if (!folders.pending) {
    throw new Error("Missing required client config: driveFoldersJson.pending");
  }

  if (!folders.scanned) {
    throw new Error("Missing required client config: driveFoldersJson.scanned");
  }

  if (!folders.statements) {
    throw new Error("Missing required client config: driveFoldersJson.statements (carpeta Rendiciones)");
  }

  if (folders.pending === folders.scanned) {
    throw new Error("Invalid client config: pending and scanned folders must be different");
  }

  if (!sheetName.trim()) {
    throw new Error("Missing required client config: sheetName");
  }

  if (!googleConfig) {
    throw new Error("Missing required client config: google credentials (projectId/clientEmail/privateKey/sheetsId)");
  }
}

function asRequiredString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
