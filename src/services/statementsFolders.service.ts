import { getPrismaClient } from "@/lib/prisma";
import { GoogleDriveService } from "@/services/googleDrive.service";
import { buildStatementPeriodFolderName, sanitizeName } from "@/lib/statementsNaming";

export interface StatementsFolders {
  buildingFolderId: string;
  periodFolderId: string;
}

/**
 * Crea/obtiene `statements/[Edificio]/[Período]`. La primera vez que se crea la
 * carpeta del edificio, la comparte pública y guarda el link en Consortium.
 * Cachea en memoria por proceso para no repetir llamadas a Drive en un ciclo.
 */
const buildingCache = new Map<string, string>();  // key: statementsRootId|consortiumId
const periodCache = new Map<string, string>();     // key: buildingFolderId|periodName

export async function resolveStatementsFolders(params: {
  drive: GoogleDriveService;
  statementsRootId: string;
  consortium: { id: string; rawName: string; statementsFolderId: string | null };
  month: number;
  year: number;
}): Promise<StatementsFolders> {
  const { drive, statementsRootId, consortium, month, year } = params;
  const prisma = getPrismaClient();

  // 1. Carpeta del edificio
  let buildingFolderId = consortium.statementsFolderId ?? null;
  const bcKey = `${statementsRootId}|${consortium.id}`;
  if (!buildingFolderId) buildingFolderId = buildingCache.get(bcKey) ?? null;

  if (!buildingFolderId) {
    const name = sanitizeName(consortium.rawName) || consortium.id;
    buildingFolderId = await drive.getOrCreateFolder(name, statementsRootId);
    const url = await drive.shareFolderPublic(buildingFolderId);
    await prisma.consortium.update({
      where: { id: consortium.id },
      data: { statementsFolderId: buildingFolderId, statementsFolderUrl: url },
    });
    buildingCache.set(bcKey, buildingFolderId);
  }

  // 2. Carpeta del período
  const periodName = buildStatementPeriodFolderName(month, year);
  const pcKey = `${buildingFolderId}|${periodName}`;
  let periodFolderId = periodCache.get(pcKey) ?? null;
  if (!periodFolderId) {
    periodFolderId = await drive.getOrCreateFolder(periodName, buildingFolderId);
    periodCache.set(pcKey, periodFolderId);
  }

  return { buildingFolderId, periodFolderId };
}
