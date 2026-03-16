import { env } from "@/config/env";
import { SheetsRowMapping } from "@/services/googleSheets.service";
import { ClientGoogleConfig, ProcessingClient } from "@/types/client.types";
import { decrypt } from "@/utils/encryption.util";

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
    "sourceFileUrl",
    "isDuplicate",
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

  if (!projectId || !clientEmail || !privateKeyRaw || !sheetsId) {
    return null;
  }

  return {
    projectId,
    clientEmail,
    privateKey: decrypt(privateKeyRaw),
    sheetsId,
  };
}

export function resolveAiConfig(client: ProcessingClient): {
  geminiApiKey?: string;
  geminiModel?: string;
  openaiApiKey?: string;
  openaiModel?: string;
} | null {
  const raw = client.extractionConfigJson;
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const geminiApiKey = asOptionalString(raw.geminiApiKey);
  const geminiModel = asOptionalString(raw.geminiModel);
  const openaiApiKey = asOptionalString(raw.openaiApiKey);
  const openaiModel = asOptionalString(raw.openaiModel);

  if (!geminiApiKey && !openaiApiKey && !geminiModel && !openaiModel) {
    return null;
  }

  return {
    geminiApiKey,
    geminiModel,
    openaiApiKey,
    openaiModel,
  };
}

export function validateClientProcessingConfig(
  client: ProcessingClient,
  sheetName: string,
  googleConfig: ClientGoogleConfig | null
): void {
  const pendingFolderId = client.driveFolderPending.trim();
  const scannedFolderId = client.driveFolderProcessed.trim();

  if (!pendingFolderId) {
    throw new Error("Missing required client config: driveFolderPending");
  }

  if (!scannedFolderId) {
    throw new Error("Missing required client config: driveFolderProcessed");
  }

  if (pendingFolderId === scannedFolderId) {
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
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
