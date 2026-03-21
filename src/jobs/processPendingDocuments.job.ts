import { env } from "@/config/env";
import { normalizeConsortiumName, consortiumFuzzyMatch, consortiumAliasMatch } from "@/lib/consortiumNormalizer";
import { refineExtractionWithRawText } from "@/lib/extraction";
import { createEmptyTokenUsageSummary } from "@/lib/createEmptyTokenUsageSummary";
import { accumulateTokenUsage } from "@/types/aiUsage.types";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";
import { ProcessJobSummary } from "@/types/process.types";
import { ClientGoogleConfig } from "@/types/client.types";
import { ConsortiumRepository } from "@/repositories/consortium.repository";
import { InvoiceRepository } from "@/repositories/invoice.repository";
import { ProviderRepository } from "@/repositories/provider.repository";
import { GoogleDriveService } from "@/services/googleDrive.service";
import { GoogleSheetsService, SheetsRowMapping } from "@/services/googleSheets.service";
import { PdfTextExtractorService } from "@/services/pdfTextExtractor.service";
import { getPrismaClient } from "@/lib/prisma";

export interface ProcessJobConfig {
  clientId: string;
  clientName: string;
  sheetName: string;
  mapping?: SheetsRowMapping;
  drivePendingFolderId?: string;
  driveScannedFolderId?: string;
  driveUnassignedFolderId?: string | null;
  driveFailedFolderId?: string | null;
  googleConfig?: ClientGoogleConfig | null;
  aiConfig?: {
    geminiApiKey?: string;
    geminiModel?: string;
    openaiApiKey?: string;
    openaiModel?: string;
  } | null;
}

export interface ProcessDriveFileInput {
  id: string;
  name: string;
  webViewLink?: string | null;
}

type GeminiModule = typeof import("@/services/geminiExtractor.service");
type OpenAiModule = typeof import("@/services/aiExtractor.service");

type ProcessingContext = {
  resolvedConfig: ProcessJobConfig;
  resolvedMapping: SheetsRowMapping;
  driveService: GoogleDriveService;
  pdfExtractor: PdfTextExtractorService;
  sheetsService: GoogleSheetsService;
  invoiceRepository: InvoiceRepository;
  consortiumRepository: ConsortiumRepository;
  providerRepository: ProviderRepository;
  geminiModule: GeminiModule | null;
  openAiModule: OpenAiModule | null;
  geminiApiKey?: string;
  openaiApiKey?: string;
  geminiModel?: string;
  openaiModel?: string;
  existingDuplicateKeys: Set<string>;
};

const DEFAULT_MAPPING: SheetsRowMapping = {
  boletaNumber: "A",
  provider: "B",
  consortium: "C",
  providerTaxId: "D",
  detail: "E",
  observation: "F",
  dueDate: "G",
  amount: "H",
  alias: "I",
  sourceFileUrl: "J",
  isDuplicate: "K",
};

function createBaseSummary(totalFound: number): ProcessJobSummary {
  return {
    clientId: "",
    clientName: "",
    totalFound,
    processed: 0,
    skipped: 0,
    failed: 0,
    unassigned: 0,
    duplicatesDetected: 0,
    errors: [],
    tokenUsage: createEmptyTokenUsageSummary(),
  };
}

function buildDriveFileUrl(fileId: string, webViewLink?: string | null): string {
  return webViewLink?.trim() || `https://drive.google.com/file/d/${fileId}/view`;
}

function buildOcrOnlyPayload(): ExtractedDocumentData {
  return {
    boletaNumber: null,
    provider: null,
    consortium: null,
    providerTaxId: null,
    detail: null,
    observation: "OCR_ONLY",
    dueDate: null,
    amount: null,
    alias: null,
  };
}

function normCuit(v: string | null | undefined): string {
  return (v ?? "").replace(/\D/g, "");
}

function normName(v: string | null | undefined): string {
  return (v ?? "").toLowerCase().replace(/[.,\-_]/g, " ").replace(/\s+/g, " ").trim();
}

async function createProcessingContext(
  config: ProcessJobConfig,
  mapping: SheetsRowMapping
): Promise<ProcessingContext> {
  const driveService = new GoogleDriveService(config.googleConfig);
  const pdfExtractor = new PdfTextExtractorService();
  const sheetsService = new GoogleSheetsService(config.googleConfig);
  const invoiceRepository = new InvoiceRepository();
  const consortiumRepository = new ConsortiumRepository();
  const providerRepository = new ProviderRepository();
  const geminiApiKey = config.aiConfig?.geminiApiKey?.trim() || env.GEMINI_API_KEY?.trim();
  const openaiApiKey = config.aiConfig?.openaiApiKey?.trim() || env.OPENAI_API_KEY?.trim();
  const geminiModel = config.aiConfig?.geminiModel?.trim() || env.GEMINI_MODEL;
  const openaiModel = config.aiConfig?.openaiModel?.trim() || env.OPENAI_MODEL;
  const geminiModule = geminiApiKey ? await import("@/services/geminiExtractor.service") : null;
  const openAiModule = openaiApiKey ? await import("@/services/aiExtractor.service") : null;

  let existingDuplicateKeys = new Set<string>();
  try {
    existingDuplicateKeys = await sheetsService.getExistingDuplicateKeys(config.sheetName, mapping);
  } catch (error) {
    console.warn(`[job:${config.clientId}] duplicate detection bootstrap failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  return {
    resolvedConfig: config, resolvedMapping: mapping, driveService, pdfExtractor,
    sheetsService, invoiceRepository, consortiumRepository, providerRepository,
    geminiModule, openAiModule, geminiApiKey, openaiApiKey, geminiModel, openaiModel,
    existingDuplicateKeys,
  };
}

interface AssignmentResult {
  consortiumId: string | undefined;
  providerId: string | undefined;
  periodId: string | undefined;
  unassigned: boolean;
  unassignedReason: string | null;
  canonicalConsortium: string | null;
  canonicalProvider: string | null;
  canonicalProviderTaxId: string | null;
}

/**
 * Resuelve consorcio y proveedor a partir de los datos extraídos por IA/OCR.
 *
 * Estrategia de matching para CONSORCIO (en orden de prioridad):
 *  1. Match exacto por canonicalName normalizado
 *  2. Fuzzy match: todos los tokens del nombre DB aparecen en el raw OCR
 *  3. Alias match: el raw OCR coincide con algún alias registrado en el consorcio
 *
 * Estrategia de matching para PROVEEDOR:
 *  1. CUIT normalizado (excluyendo CUIT del consorcio)
 *  2. Nombre exacto / alias
 *  3. Nombre parcial
 */
async function resolveAssignment(
  extracted: ExtractedDocumentData,
  clientId: string,
  fileId: string,
  consortiumRepository: ConsortiumRepository,
  providerRepository: ProviderRepository
): Promise<AssignmentResult> {
  const tag = `[assign fileId=${fileId}]`;
  const base: AssignmentResult = {
    consortiumId: undefined, providerId: undefined, periodId: undefined,
    unassigned: true, unassignedReason: null,
    canonicalConsortium: null, canonicalProvider: null, canonicalProviderTaxId: null,
  };

  // ── 1. Consorcio ─────────────────────────────────────────────────────────

  const rawConsortium = extracted.consortium?.trim() ?? null;
  console.log(`${tag} raw consortium="${rawConsortium}"`);

  if (!rawConsortium) {
    return { ...base, unassignedReason: "No se pudo extraer el consorcio del PDF" };
  }

  const prisma = getPrismaClient();

  // Cargar todos los consorcios del cliente una sola vez
  const allConsortiums = await prisma.consortium.findMany({
    where: { clientId },
    select: { id: true, canonicalName: true, rawName: true, cuit: true, aliases: true },
  });

  const canonicalName = normalizeConsortiumName(rawConsortium);
  console.log(`${tag} normalized consortium="${canonicalName}"`);

  // Intento 1: match exacto por canonicalName
  let consortiumRow = allConsortiums.find((c) => c.canonicalName === canonicalName);
  let matchMethod = consortiumRow ? "exact" : "";

  // Intento 2: fuzzy match (tokens del nombre DB en el raw OCR)
  if (!consortiumRow) {
    const fuzzy = allConsortiums.find((c) => consortiumFuzzyMatch(rawConsortium, c.canonicalName));
    if (fuzzy) { consortiumRow = fuzzy; matchMethod = "fuzzy"; }
  }

  // Intento 3: alias match
  if (!consortiumRow) {
    const aliased = allConsortiums.find((c) => {
      const aliases = (c.aliases ?? "").split("|").map((a) => a.trim()).filter(Boolean);
      return consortiumAliasMatch(rawConsortium, aliases);
    });
    if (aliased) { consortiumRow = aliased; matchMethod = "alias"; }
  }

  if (!consortiumRow) {
    console.warn(
      `${tag} → unassigned: consorcio "${rawConsortium}" (norm: "${canonicalName}") no encontrado. ` +
      `DB: [${allConsortiums.map((c) => `"${c.canonicalName}"`).join(", ")}]`
    );
    return {
      ...base,
      unassignedReason: `Consorcio no encontrado: "${rawConsortium}" → norm: "${canonicalName}"`,
    };
  }

  console.log(`${tag} consortium found method=${matchMethod} id=${consortiumRow.id} canonical="${consortiumRow.canonicalName}"`);

  // Buscar el objeto completo para incluir periods
  const consortium = await consortiumRepository.findByCanonicalName(clientId, consortiumRow.canonicalName);
  if (!consortium) {
    return { ...base, unassignedReason: `Consorcio no encontrado: "${rawConsortium}"` };
  }

  const activePeriod = await consortiumRepository.findActivePeriod(consortium.id);
  base.consortiumId = consortium.id;
  base.periodId = activePeriod?.id;
  base.canonicalConsortium = consortium.rawName;

  const consortiumCuitNorm = normCuit((consortium as any).cuit);

  // ── 2. Proveedor ─────────────────────────────────────────────────────────

  const allProviders = await prisma.provider.findMany({
    where: { clientId },
    select: { id: true, canonicalName: true, cuit: true, alias: true },
  });

  const rawCuit     = extracted.providerTaxId?.trim() ?? null;
  const rawName     = extracted.provider?.trim() ?? null;
  const normOcrCuit = normCuit(rawCuit);
  const normOcrName = normName(rawName);

  console.log(`${tag} OCR taxId="${rawCuit}"(norm="${normOcrCuit}") provider="${rawName}"(norm="${normOcrName}")`);

  let matched: typeof allProviders[0] | undefined;
  let providerMatchMethod = "";

  // Intento 1: CUIT normalizado, excluyendo CUIT del consorcio
  if (normOcrCuit.length >= 10 && normOcrCuit !== consortiumCuitNorm) {
    matched = allProviders.find((p) => normCuit(p.cuit) === normOcrCuit);
    if (matched) providerMatchMethod = `CUIT (norm: ${normOcrCuit})`;
  } else if (normOcrCuit.length >= 10 && normOcrCuit === consortiumCuitNorm) {
    console.warn(`${tag} OCR CUIT coincide con consorcio — fallback a nombre`);
  }

  // Intento 2: nombre / alias exacto
  if (!matched && normOcrName.length >= 3) {
    matched = allProviders.find((p) =>
      normName(p.canonicalName) === normOcrName || (p.alias && normName(p.alias) === normOcrName)
    );
    if (matched) providerMatchMethod = `name exact ("${normOcrName}")`;
  }

  // Intento 3: nombre parcial
  if (!matched && normOcrName.length >= 5) {
    matched = allProviders.find((p) =>
      normName(p.canonicalName).includes(normOcrName) ||
      normOcrName.includes(normName(p.canonicalName).slice(0, 5))
    );
    if (matched) providerMatchMethod = `name partial ("${normOcrName}")`;
  }

  console.log(`${tag} provider match=${Boolean(matched)} method="${providerMatchMethod}" name="${matched?.canonicalName ?? "none"}"`);

  if (!matched) {
    return {
      ...base,
      unassigned: true,
      unassignedReason: `Proveedor no identificado. OCR taxId="${rawCuit}" provider="${rawName}"`,
    };
  }

  try {
    await providerRepository.linkToConsortium(matched.id, consortium.id);
  } catch (linkErr) {
    console.warn(`${tag} linkToConsortium non-fatal: ${linkErr instanceof Error ? linkErr.message : linkErr}`);
  }

  return {
    consortiumId: consortium.id,
    providerId: matched.id,
    periodId: activePeriod?.id,
    unassigned: false,
    unassignedReason: null,
    canonicalConsortium: consortium.rawName,
    canonicalProvider: matched.canonicalName,
    canonicalProviderTaxId: matched.cuit ?? rawCuit,
  };
}

async function processDriveFile(
  file: ProcessDriveFileInput,
  context: ProcessingContext,
  summary: ProcessJobSummary
): Promise<void> {
  const {
    resolvedConfig, resolvedMapping, driveService, pdfExtractor, sheetsService,
    invoiceRepository, consortiumRepository, providerRepository,
    geminiModule, openAiModule, geminiApiKey, openaiApiKey, geminiModel, openaiModel,
    existingDuplicateKeys,
  } = context;

  const runStep = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); }
    catch (error) { throw new Error(`${label} failed: ${error instanceof Error ? error.message : "Unknown error"}`); }
  };

  try {
    console.log(`[job:${resolvedConfig.clientId}] processing fileId=${file.id} name="${file.name}"`);
    const sourceFileUrl = buildDriveFileUrl(file.id, file.webViewLink);
    const buffer = await runStep("download", () => driveService.downloadFile(file.id));

    const fileHash = invoiceRepository.computeDocumentHash(buffer);
    const existingByHash = await runStep("dedup-hash-check", () =>
      invoiceRepository.findDuplicateByHash(resolvedConfig.clientId, fileHash)
    );
    console.log(`[job:${resolvedConfig.clientId}] hash=${fileHash.slice(0, 8)}... duplicateByHash=${Boolean(existingByHash)}`);

    let extracted: ExtractedDocumentData | null = null;
    let isDuplicate = Boolean(existingByHash);

    if (existingByHash?.extraction) {
      const { sourceFileUrl: _url, isDuplicate: _dup, ...storedFields } =
        existingByHash.extraction as ExtractedDocumentData;
      extracted = { ...storedFields };
      const text = await runStep("extract-text", () => pdfExtractor.extractTextFromPdf(buffer));
      extracted = refineExtractionWithRawText(extracted, text);
    } else {
      const text = await runStep("extract-text", () => pdfExtractor.extractTextFromPdf(buffer));
      const providerErrors: string[] = [];

      if (geminiModule) {
        try {
          const extractor = new geminiModule.GeminiExtractorService({ apiKey: geminiApiKey, model: geminiModel });
          extracted = await runStep("gemini-extract", () => extractor.extractStructuredData(text));
          accumulateTokenUsage(summary.tokenUsage, extractor.getLastUsage?.());
        } catch (error) {
          providerErrors.push(error instanceof Error ? error.message : "Gemini unknown error");
        }
      }

      if (extracted === null && openAiModule) {
        try {
          const extractor = new openAiModule.AiExtractorService({ apiKey: openaiApiKey, model: openaiModel });
          extracted = await runStep("openai-extract", () => extractor.extractStructuredData(text));
          accumulateTokenUsage(summary.tokenUsage, extractor.getLastUsage?.());
        } catch (error) {
          providerErrors.push(error instanceof Error ? error.message : "OpenAI unknown error");
        }
      }

      if (extracted === null) {
        if (providerErrors.length > 0) {
          console.warn(`[job:${resolvedConfig.clientId}] AI fallback OCR_ONLY file=${file.id}: ${providerErrors.join(" | ")}`);
        }
        extracted = buildOcrOnlyPayload();
      }
    }

    if (extracted === null) throw new Error("extraction produced no result unexpectedly");

    console.log(
      `[job:${resolvedConfig.clientId}] extracted consortium="${extracted.consortium ?? "null"}"` +
      ` provider="${extracted.provider ?? "null"}" taxId="${extracted.providerTaxId ?? "null"}"`
    );

    if (!isDuplicate) {
      const dup = await runStep("dedup-business-check", () =>
        invoiceRepository.findDuplicateByBusinessKey(resolvedConfig.clientId, extracted!)
      );
      isDuplicate = Boolean(dup);
    }

    const duplicateKey = invoiceRepository.buildBusinessKeyFromData(extracted);
    if (!isDuplicate && duplicateKey) isDuplicate = existingDuplicateKeys.has(duplicateKey);

    extracted.sourceFileUrl = sourceFileUrl;
    extracted.isDuplicate = isDuplicate ? "YES" : "NO";

    const assignment = await resolveAssignment(
      extracted, resolvedConfig.clientId, file.id, consortiumRepository, providerRepository
    );

    if (!assignment.unassigned) {
      if (assignment.canonicalConsortium)    extracted.consortium    = assignment.canonicalConsortium;
      if (assignment.canonicalProvider)      extracted.provider      = assignment.canonicalProvider;
      if (assignment.canonicalProvider)      extracted.alias         = assignment.canonicalProvider;
      if (assignment.canonicalProviderTaxId) extracted.providerTaxId = assignment.canonicalProviderTaxId;
      console.log(
        `[job:${resolvedConfig.clientId}] canonized consortium="${extracted.consortium}" provider="${extracted.provider}" taxId="${extracted.providerTaxId}"`
      );
    }

    const { sourceFileUrl: _url, isDuplicate: _dup, ...extractionFields } = extracted;

    if (assignment.unassigned) {
      console.warn(`[job:${resolvedConfig.clientId}] unassigned fileId=${file.id} reason="${assignment.unassignedReason}"`);
      if (resolvedConfig.driveUnassignedFolderId && resolvedConfig.drivePendingFolderId) {
        await runStep("move-to-unassigned", () =>
          driveService.moveFileToUnassigned(file.id, resolvedConfig.drivePendingFolderId!, resolvedConfig.driveUnassignedFolderId!)
        );
      }
      await runStep("invoice-save", () =>
        invoiceRepository.saveProcessedInvoice({
          clientId: resolvedConfig.clientId, documentHash: fileHash, fileId: file.id,
          sourceFileUrl, extraction: extractionFields, isDuplicate,
          consortiumId: assignment.consortiumId, providerId: undefined, periodId: assignment.periodId,
        })
      );
      summary.unassigned += 1;
      return;
    }

    await runStep("sheets-insert", () =>
      sheetsService.insertRow(resolvedConfig.sheetName, extracted!, resolvedMapping)
    );
    await runStep("move-to-scanned", () =>
      driveService.moveFileToScanned(file.id, resolvedConfig.drivePendingFolderId, resolvedConfig.driveScannedFolderId)
    );
    await runStep("invoice-save", () =>
      invoiceRepository.saveProcessedInvoice({
        clientId: resolvedConfig.clientId, documentHash: fileHash, fileId: file.id,
        sourceFileUrl, extraction: extractionFields, isDuplicate,
        consortiumId: assignment.consortiumId, providerId: assignment.providerId, periodId: assignment.periodId,
      })
    );

    if (duplicateKey) existingDuplicateKeys.add(duplicateKey);
    if (isDuplicate)  summary.duplicatesDetected += 1;
    summary.processed += 1;
    console.log(`[job:${resolvedConfig.clientId}] done fileId=${file.id} duplicate=${isDuplicate} processed=${summary.processed} unassigned=${summary.unassigned}`);

  } catch (error) {
    summary.failed += 1;
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    summary.errors.push({ fileId: file.id, fileName: file.name, error: errorMessage });
    console.error(`[job:${resolvedConfig.clientId}] failed fileId=${file.id} error=${errorMessage}`);
    if (resolvedConfig.driveFailedFolderId && resolvedConfig.drivePendingFolderId) {
      try {
        await driveService.moveFileToFailed(file.id, resolvedConfig.drivePendingFolderId, resolvedConfig.driveFailedFolderId);
      } catch (e) {
        console.error(`[job:${resolvedConfig.clientId}] could not move to failedFolder: ${e instanceof Error ? e.message : "Unknown"}`);
      }
    }
  }
}

function buildLegacyConfig(sheetName: string, mapping?: SheetsRowMapping): ProcessJobConfig {
  return {
    clientId: "default-env-client", clientName: "Default Client", sheetName, mapping,
    drivePendingFolderId: env.GOOGLE_DRIVE_PENDING_FOLDER_ID,
    driveScannedFolderId: env.GOOGLE_DRIVE_SCANNED_FOLDER_ID,
    driveUnassignedFolderId: null, driveFailedFolderId: null, googleConfig: null,
  };
}

function normalizeConfig(config: ProcessJobConfig | string, mapping?: SheetsRowMapping): ProcessJobConfig {
  if (typeof config === "string") return buildLegacyConfig(config, mapping);
  return {
    ...config, mapping: config.mapping ?? mapping,
    drivePendingFolderId: config.drivePendingFolderId ?? env.GOOGLE_DRIVE_PENDING_FOLDER_ID,
    driveScannedFolderId: config.driveScannedFolderId ?? env.GOOGLE_DRIVE_SCANNED_FOLDER_ID,
    driveUnassignedFolderId: config.driveUnassignedFolderId ?? null,
    driveFailedFolderId: config.driveFailedFolderId ?? null,
  };
}

export async function processPendingDocumentsJob(
  config: ProcessJobConfig | string,
  mapping?: SheetsRowMapping
): Promise<ProcessJobSummary> {
  const resolvedConfig = normalizeConfig(config, mapping);
  const resolvedMapping = resolvedConfig.mapping ?? DEFAULT_MAPPING;
  const context = await createProcessingContext(resolvedConfig, resolvedMapping);
  const files = await context.driveService.listPendingPdfFiles(resolvedConfig.drivePendingFolderId);
  const processedIds = new Set<string>();

  console.log(`[job:${resolvedConfig.clientId}] start client="${resolvedConfig.clientName}" pendingFolder=${resolvedConfig.drivePendingFolderId}`);

  const summary = createBaseSummary(files.length);
  summary.clientId = resolvedConfig.clientId;
  summary.clientName = resolvedConfig.clientName;

  for (const file of files) {
    if (processedIds.has(file.id)) { summary.skipped += 1; continue; }
    processedIds.add(file.id);
    await processDriveFile({ id: file.id, name: file.name, webViewLink: file.webViewLink }, context, summary);
  }

  console.log(`[job:${resolvedConfig.clientId}] summary totalFound=${summary.totalFound} processed=${summary.processed} unassigned=${summary.unassigned} failed=${summary.failed} duplicates=${summary.duplicatesDetected}`);
  return summary;
}

export async function processSingleDriveFileJob(
  config: ProcessJobConfig,
  file: ProcessDriveFileInput,
  mapping?: SheetsRowMapping
): Promise<ProcessJobSummary> {
  const resolvedConfig = normalizeConfig(config, mapping);
  const resolvedMapping = resolvedConfig.mapping ?? DEFAULT_MAPPING;
  const context = await createProcessingContext(resolvedConfig, resolvedMapping);
  const summary = createBaseSummary(1);
  summary.clientId = resolvedConfig.clientId;
  summary.clientName = resolvedConfig.clientName;
  await processDriveFile(file, context, summary);
  return summary;
}
