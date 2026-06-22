import { env } from "@/config/env";
import { normalizeConsortiumName } from "@/lib/consortiumNormalizer";
import { matchConsortium, matchProvider, normName } from "@/lib/assignmentMatching";
import { cuitDigits, formatCuit, extractCuitsFromText } from "@/lib/cuit";
import { identifyLSPProvider, LSPProvider, LSP_FALLBACK_NAMES, annotateSindicalProvider, usesConsortiumCuit } from "@/lib/extraction";
import { refineExtractionWithRawText } from "@/lib/extraction";
import { createEmptyTokenUsageSummary } from "@/lib/createEmptyTokenUsageSummary";
import { pipelineLog } from "@/lib/logger";
import { safeDebugLog } from "@/lib/debugSanitize";
import { accumulateTokenUsage } from "@/types/aiUsage.types";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";
import { ProcessJobSummary } from "@/types/process.types";
import { ClientGoogleConfig } from "@/types/client.types";
import { ConsortiumRepository } from "@/repositories/consortium.repository";
import { InvoiceRepository } from "@/repositories/invoice.repository";
import { ProviderRepository } from "@/repositories/provider.repository";
import { LspServiceRepository } from "@/repositories/lspService.repository";
import { GoogleDriveService } from "@/services/googleDrive.service";
import { GoogleSheetsService, SheetsRowMapping } from "@/services/googleSheets.service";
import { AiExtractionChain, createAiExtractionChain } from "@/services/aiExtraction";
import { isRateLimitError, RateLimitError } from "@/lib/aiErrors";
import { PdfTextExtractorService } from "@/services/pdfTextExtractor.service";
import { isMissingAmount, cuitAppearsInText, appendNoAmountTag, markNotBoleta } from "@/lib/documentValidation";
import { classifyDocumentType } from "@/lib/documentClassifier";
import { runPipeline } from "@/jobs/pipeline/runner";
import { createPipelineContext, type PipelineContext, type StepResult } from "@/jobs/pipeline/context";

export interface ProcessJobConfig {
  clientId: string;
  clientName: string;
  sheetName: string;
  mapping?: SheetsRowMapping;
  drivePendingFolderId?: string;
  driveScannedFolderId?: string;
  driveUnassignedFolderId?: string | null;
  driveFailedFolderId?: string | null;
  driveProcessingFolderId?: string | null;
  driveDuplicatesFolderId?: string | null;
  driveStatementsFolderId?: string | null;
  googleConfig?: ClientGoogleConfig | null;
  aiConfig?: {
    geminiApiKey?: string;
    geminiModel?: string;
    openaiApiKey?: string;
    openaiModel?: string;
    anthropicApiKey?: string;
    anthropicModel?: string;
  } | null;
  debugMode?: boolean;
}

export interface ProcessDriveFileInput {
  id: string;
  name: string;
  mimeType?: string | null;
  webViewLink?: string | null;
}

type GeminiModule = typeof import("@/services/geminiExtractor.service");

// Seams inyectables para testing: las deps de organización en Rendiciones que el
// pipeline carga con import dinámico inline. En producción quedan undefined y se
// resuelven con el mismo import dinámico (comportamiento idéntico al legacy); en
// tests se inyectan mocks para ejercitar el paso sin tocar Drive real.
type ResolveStatementsFolders = typeof import("@/services/statementsFolders.service")["resolveStatementsFolders"];
type BuildInvoiceFileName = typeof import("@/lib/statementsNaming")["buildInvoiceFileName"];

export type ProcessingContext = {
  resolvedConfig: ProcessJobConfig;
  resolvedMapping: SheetsRowMapping;
  driveService: GoogleDriveService;
  pdfExtractor: PdfTextExtractorService;
  sheetsService: GoogleSheetsService;
  invoiceRepository: InvoiceRepository;
  consortiumRepository: ConsortiumRepository;
  providerRepository: ProviderRepository;
  lspServiceRepository: LspServiceRepository;
  // El módulo Gemini se mantiene aparte de la cadena de texto porque la
  // extracción de imágenes (Vision) y el fallback visual del emisor no son
  // parte del fallback Gemini→OpenAI→Claude.
  geminiModule: GeminiModule | null;
  aiChain: AiExtractionChain;
  geminiApiKey?: string;
  geminiModel?: string;
  existingDuplicateKeys: Set<string>;
  // Seams opcionales (ver arriba). Default al import dinámico real en prod.
  resolveStatementsFolders?: ResolveStatementsFolders;
  buildInvoiceFileName?: BuildInvoiceFileName;
};

export const DEFAULT_MAPPING: SheetsRowMapping = {
  boletaNumber: "A",
  provider: "B",
  consortium: "C",
  providerTaxId: "D",
  detail: "E",
  observation: "F",
  dueDate: "G",
  amount: "H",
  alias: "I",
  clientNumber: "J",
  sourceFileUrl: "K",
  isDuplicate: "L",
  period: "M",
  paymentStatus: "N",
  bank: "O",
  remainingBalance: "P",
  paidAmount: "Q",
  installmentsCount: "R",
  paymentDate: "S",
  receiptUrl: "T",
  paidWith: "U",
};

export function createBaseSummary(totalFound: number): ProcessJobSummary {
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

/** Traduce el nombre corto del router LSP al nombre canónico (razón social) en DB */
const LSP_ROUTER_TO_CANONICAL: Record<string, string> = {
  "PERSONAL":    "TELECOM ARGENTINA S.A.",
  "EDESUR":      "EDESUR S.A.",
  "EDENOR":      "EDENOR S.A.",
  "AYSA":        "AYSA S.A.",
  "METROGAS":    "METROGAS S.A.",
  "NATURGY":     "NATURGY S.A.",
  "CAMUZZI":     "CAMUZZI GAS PAMPEANA S.A.",
  "LITORAL_GAS": "LITORAL GAS S.A.",
  // Boletas sindicales: sin clientNumber (no usan LspService); el nombre
  // canónico sugerido en el directorio es el mismo nombre corto.
  "SUTERH":      "SUTERH",
  "FATERYH":     "FATERYH",
  "SERACARH":    "SERACARH",
};

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
    clientNumber: null,
    paymentMethod: null,
    allTaxIds: [],
  };
}

function formatPeriodLabel(month: number, year: number): string {
  return `${String(month).padStart(2, "0")}/${year}`;
}

// normCuit/normName locales eliminadas: usar cuitDigits (lib/cuit) y normName
// (lib/assignmentMatching) — fuente única, sin normalizadores duplicados.

/** Normaliza el método de match a una categoría sin PII (sin el detalle entre paréntesis). */
function normalizeMatchMethod(m: string | null | undefined): string | null {
  if (!m) return null;
  const lower = m.toLowerCase();
  if (lower.startsWith("cuit")) return "CUIT";
  if (lower.includes("exacto")) return "exacto";
  if (lower.startsWith("fuzzy")) return "fuzzy";
  if (lower.startsWith("alias")) return "alias";
  if (lower.includes("parcial")) return "parcial";
  if (lower === "lsp") return "lsp";
  return m;
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
  const lspServiceRepository = new LspServiceRepository();
  const geminiApiKey = config.aiConfig?.geminiApiKey?.trim() || env.GEMINI_API_KEY?.trim();
  const openaiApiKey = config.aiConfig?.openaiApiKey?.trim() || env.OPENAI_API_KEY?.trim();
  const anthropicApiKey = config.aiConfig?.anthropicApiKey?.trim() || env.ANTHROPIC_API_KEY?.trim();
  const geminiModel = config.aiConfig?.geminiModel?.trim() || env.GEMINI_MODEL;
  const openaiModel = config.aiConfig?.openaiModel?.trim() || env.OPENAI_MODEL;
  const anthropicModel = config.aiConfig?.anthropicModel?.trim() || env.ANTHROPIC_MODEL;
  const geminiModule = geminiApiKey ? await import("@/services/geminiExtractor.service") : null;
  const aiChain = await createAiExtractionChain({
    gemini: { apiKey: geminiApiKey, model: geminiModel },
    openai: { apiKey: openaiApiKey, model: openaiModel },
    anthropic: { apiKey: anthropicApiKey, model: anthropicModel },
  });

  let existingDuplicateKeys = new Set<string>();
  try {
    existingDuplicateKeys = await sheetsService.getExistingDuplicateKeys(config.sheetName, mapping);
  } catch (error) {
    pipelineLog.stepStart(config.clientId, `Dedup bootstrap falló: ${error instanceof Error ? error.message : "Unknown"}`);
  }

  return {
    resolvedConfig: config, resolvedMapping: mapping, driveService, pdfExtractor,
    sheetsService, invoiceRepository, consortiumRepository, providerRepository,
    lspServiceRepository,
    geminiModule, aiChain,
    geminiApiKey, geminiModel,
    existingDuplicateKeys,
  };
}

export interface AssignmentResult {
  consortiumId: string | undefined;
  providerId: string | undefined;
  periodId: string | undefined;
  periodLabel: string | null;
  lspServiceId: string | null;
  unassigned: boolean;
  unassignedReason: string | null;
  canonicalConsortium: string | null;
  canonicalProvider: string | null;
  canonicalProviderTaxId: string | null;
  providerPaymentAlias: string | null;
  consortiumBank: string | null;
  statementsFolderId: string | null;
  periodMonth: number | null;
  periodYear: number | null;
  consortiumMatchMethod: string | null;
  providerMatchMethod: string | null;
  reasonCategory: string | null;
}

async function resolveAssignment(
  extracted: ExtractedDocumentData,
  clientId: string,
  fileId: string,
  consortiumRepository: ConsortiumRepository,
  providerRepository: ProviderRepository,
  lspServiceRepository: LspServiceRepository,
  lspProvider: LSPProvider | null
): Promise<AssignmentResult> {
  const base: AssignmentResult = {
    consortiumId: undefined, providerId: undefined, periodId: undefined,
    periodLabel: null, lspServiceId: null,
    unassigned: true, unassignedReason: null,
    canonicalConsortium: null, canonicalProvider: null, canonicalProviderTaxId: null,
    providerPaymentAlias: null, consortiumBank: null,
    statementsFolderId: null, periodMonth: null, periodYear: null,
    consortiumMatchMethod: null, providerMatchMethod: null, reasonCategory: null,
  };

  // ── 0. LSP fast path: resolver proveedor por CUIT + LspService por clientNumber ──

  const normalizedClientNumber = extracted.clientNumber?.replace(/\s+/g, "").replace(/^0+/, "") || null;
  const allTaxIds = (extracted.allTaxIds ?? []).map((c) => cuitDigits(c)).filter((c) => c.length >= 10);

  // Boletas sindicales: NO son LSP de servicios. Su CUIT es del CONSORCIO, no del
  // proveedor → se excluyen del fast-path (resolver proveedor por CUIT / por
  // clientNumber). Van directo al matching normal: consorcio por CUIT, proveedor
  // por NOMBRE.
  const isSindicalLsp = usesConsortiumCuit(lspProvider);

  // Resolver proveedor LSP por CUIT en tabla Provider
  let lspProviderId: string | null = null;
  let lspProviderCanonical: string | null = null;
  let lspProviderTaxId: string | null = null;
  let lspProviderAlias: string | null = null;

  if (lspProvider && !isSindicalLsp && allTaxIds.length > 0) {
    const allProviders = await providerRepository.findAllForMatching(clientId);

    for (const cuit of allTaxIds) {
      const found = allProviders.find((p) => cuitDigits(p.cuit) === cuit);
      if (found) {
        lspProviderId = found.id;
        lspProviderCanonical = found.canonicalName;
        lspProviderTaxId = found.cuit;
        lspProviderAlias = found.paymentAlias ?? null;
        pipelineLog.lspProviderResolvedFromDB(clientId, found.canonicalName, cuit);
        break;
      }
    }

    if (!lspProviderId) {
      pipelineLog.lspProviderNotInDB(clientId, lspProvider);
    }
  }

  // Traducir nombre del router al nombre canónico en DB
  const lspProviderCanonicalName = lspProvider ? (LSP_ROUTER_TO_CANONICAL[lspProvider] ?? lspProvider) : null;

  if (lspProvider && lspProvider !== "GENERIC_LSP" && normalizedClientNumber) {
    try {
      // Intento 1: buscar por providerId (FK) si lo tenemos
      let lspService = lspProviderId
        ? await lspServiceRepository.findByProviderId(clientId, lspProviderId, normalizedClientNumber)
        : null;

      // Intento 2: fallback a campo texto providerName (nombre canónico)
      if (!lspService) {
        lspService = await lspServiceRepository.findByProviderName(
          clientId, lspProviderCanonicalName!, normalizedClientNumber
        );
      }

      if (lspService) {
        pipelineLog.stepStart(clientId, `LspService match: ${lspProvider} clientNumber=${lspService.clientNumber}`);

        // Actualizar providerId si no estaba seteado y lo tenemos
        if (lspProviderId && !lspService.providerId) {
          await lspServiceRepository
            .setProviderId(lspService.id, lspProviderId)
            .catch(() => { /* non-fatal */ });
        }

        // Resolver proveedor: preferir CUIT lookup, luego FK del LspService
        const resolvedProvider = lspProviderId
          ? { id: lspProviderId, canonicalName: lspProviderCanonical, cuit: lspProviderTaxId, paymentAlias: lspProviderAlias }
          : lspService.providerRef;

        const activePeriod = await consortiumRepository.findActivePeriod(lspService.consortiumId);

        return {
          consortiumId: lspService.consortiumId,
          providerId: resolvedProvider?.id ?? undefined,
          periodId: activePeriod?.id,
          periodLabel: activePeriod ? formatPeriodLabel(activePeriod.month, activePeriod.year) : null,
          lspServiceId: lspService.id,
          unassigned: false,
          unassignedReason: null,
          canonicalConsortium: lspService.consortium.rawName,
          canonicalProvider: resolvedProvider?.canonicalName ?? LSP_FALLBACK_NAMES[lspProvider] ?? lspProvider,
          canonicalProviderTaxId: resolvedProvider?.cuit ?? extracted.providerTaxId,
          providerPaymentAlias: resolvedProvider?.paymentAlias ?? null,
          consortiumBank: lspService.consortium.bank ?? null,
          statementsFolderId: lspService.consortium.statementsFolderId ?? null,
          periodMonth: activePeriod?.month ?? null,
          periodYear: activePeriod?.year ?? null,
          consortiumMatchMethod: "lsp",
          providerMatchMethod: "lsp",
          reasonCategory: null,
        };
      }

      pipelineLog.lspClientNumberNotRegistered(clientId, lspProviderCanonicalName!, normalizedClientNumber);
      return {
        ...base,
        unassigned: true,
        unassignedReason: `LSP ${lspProviderCanonicalName} - Nro cliente ${normalizedClientNumber} no registrado en LspServices`,
        reasonCategory: "lsp_clientnumber_not_registered",
      };
    } catch (err) {
      pipelineLog.stepStart(clientId, `LspService lookup error: ${err instanceof Error ? err.message : "Unknown"} → fallback a matching normal`);
    }
  }

  // ── 1. Consorcio ─────────────────────────────────────────────────────────

  const rawConsortium = extracted.consortium?.trim() ?? null;

  const allConsortiums = await consortiumRepository.findAllForMatching(clientId);

  // Matching en 4 niveles (CUIT → exacto → fuzzy → alias), ver lib/assignmentMatching.
  const consortiumMatch = matchConsortium(allConsortiums, rawConsortium, allTaxIds);

  if (!consortiumMatch) {
    if (rawConsortium) {
      const canonicalName = normalizeConsortiumName(rawConsortium);
      pipelineLog.consortiumNotFound(
        clientId,
        rawConsortium,
        canonicalName,
        allConsortiums.map((c) => c.canonicalName)
      );
      return {
        ...base,
        unassignedReason: `Consorcio no encontrado: "${rawConsortium}" → norm: "${canonicalName}"`,
        reasonCategory: "consortium_not_found",
      };
    }
    return { ...base, unassignedReason: "No se pudo extraer el consorcio del PDF ni matchear por CUIT", reasonCategory: "consortium_not_found" };
  }

  const consortiumRow = consortiumMatch.row;
  pipelineLog.consortiumMatch(clientId, consortiumMatch.method, consortiumRow.canonicalName);
  base.consortiumMatchMethod = normalizeMatchMethod(consortiumMatch.method);

  const consortium = await consortiumRepository.findByCanonicalName(clientId, consortiumRow.canonicalName);
  if (!consortium) {
    return { ...base, unassignedReason: `Consorcio no encontrado: "${rawConsortium}"`, reasonCategory: "consortium_not_found" };
  }

  const activePeriod = await consortiumRepository.findActivePeriod(consortium.id);
  if (!activePeriod) {
    pipelineLog.stepStart(clientId, `⚠️ No se encontró período activo para consorcio ${consortium.canonicalName}`);
  }
  base.consortiumId = consortium.id;
  base.periodId = activePeriod?.id;
  base.periodLabel = activePeriod ? formatPeriodLabel(activePeriod.month, activePeriod.year) : null;
  base.canonicalConsortium = consortium.rawName;
  base.consortiumBank = consortium.bank ?? null;
  base.statementsFolderId = consortium.statementsFolderId ?? null;
  base.periodMonth = activePeriod?.month ?? null;
  base.periodYear = activePeriod?.year ?? null;

  const consortiumCuitNorm = cuitDigits((consortium as any).cuit);

  // ── 2. Proveedor ─────────────────────────────────────────────────────────

  const allProviders = await providerRepository.findAllForMatching(clientId);

  const rawCuit     = extracted.providerTaxId?.trim() ?? null;
  const rawName     = extracted.provider?.trim() ?? null;
  const normOcrCuit = cuitDigits(rawCuit);
  const normOcrName = normName(rawName);

  // Matching en 4 niveles (CUIT allTaxIds → CUIT providerTaxId → nombre exacto →
  // nombre parcial), ver lib/assignmentMatching.
  const providerMatch = matchProvider(allProviders, rawCuit, rawName, allTaxIds, consortiumCuitNorm);

  // Log informativo: el CUIT del OCR coincide con el del consorcio (no se usa como
  // proveedor). Se emite salvo que el proveedor se haya resuelto por allTaxIds.
  const matchedByAllTaxIds = providerMatch?.method.startsWith("CUIT allTaxIds") ?? false;
  if (normOcrCuit.length >= 10 && normOcrCuit === consortiumCuitNorm && !matchedByAllTaxIds) {
    pipelineLog.providerCuitMatchesConsortium(clientId, normOcrCuit);
  }

  if (!providerMatch) {
    pipelineLog.providerNotFound(clientId, rawCuit, rawName, normOcrCuit, normOcrName);
    return {
      ...base,
      unassigned: true,
      unassignedReason: `Proveedor no identificado. OCR taxId="${rawCuit}" provider="${rawName}"`,
      reasonCategory: "provider_not_found",
    };
  }

  const matched = providerMatch.row;
  pipelineLog.providerMatch(clientId, providerMatch.method, matched.canonicalName);

  try {
    await providerRepository.linkToConsortium(matched.id, consortium.id);
  } catch (linkErr) {
    // Non-fatal
  }

  return {
    consortiumId: consortium.id,
    providerId: matched.id,
    periodId: activePeriod?.id,
    periodLabel: activePeriod ? formatPeriodLabel(activePeriod.month, activePeriod.year) : null,
    lspServiceId: null,
    unassigned: false,
    unassignedReason: null,
    canonicalConsortium: consortium.rawName,
    canonicalProvider: matched.canonicalName,
    canonicalProviderTaxId: matched.cuit ?? rawCuit,
    providerPaymentAlias: matched.paymentAlias ?? null,
    consortiumBank: base.consortiumBank,
    statementsFolderId: base.statementsFolderId,
    periodMonth: base.periodMonth,
    periodYear: base.periodYear,
    consortiumMatchMethod: base.consortiumMatchMethod,
    providerMatchMethod: normalizeMatchMethod(providerMatch.method),
    reasonCategory: null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Pasos del pipeline (refactor H2 — Pipe & Filter). Cada paso opera sobre el
// `PipelineContext`, hace sus side-effects y devuelve `continue`/`halt`. El
// runner (pipeline/runner.ts) los orquesta, corta al primer `halt` y centraliza
// el manejo de errores + la emisión de [metrics]. Orden de ejecución en la lista
// que arma `processDriveFile` (abajo).
// ════════════════════════════════════════════════════════════════════════════

/** 1. Descarga el PDF de Drive y lo bloquea moviéndolo a Procesando (si aplica). */
async function downloadAndLockStep(ctx: PipelineContext): Promise<StepResult> {
  const { file } = ctx;
  const { resolvedConfig, driveService } = ctx.deps;
  const cid = resolvedConfig.clientId;

  pipelineLog.fileStart(cid, file.id, file.name);

  ctx.sourceFileUrl = buildDriveFileUrl(file.id, file.webViewLink);
  ctx.buffer = await ctx.runStep("Descarga de Drive", () => driveService.downloadFile(file.id), "download");

  // ── Lock de archivo: mover a carpeta Procesando para evitar que otro ciclo
  // concurrente lo reprocese mientras estamos trabajando en él.
  const processingFolderId = resolvedConfig.driveProcessingFolderId ?? null;
  if (processingFolderId && resolvedConfig.drivePendingFolderId) {
    try {
      await driveService.moveFileToFolder(file.id, resolvedConfig.drivePendingFolderId, processingFolderId);
      pipelineLog.stepStart(cid, `→ Lock: movido a Procesando`);
    } catch (lockError) {
      const msg = lockError instanceof Error ? lockError.message : "Unknown error";
      pipelineLog.stepStart(cid, `⚠️ No se pudo mover a Procesando: ${msg}`);
    }
  }

  // Carpeta origen para los movimientos finales: si hay lock, venimos de Procesando;
  // si no, seguimos viniendo de Pendientes (comportamiento legacy).
  ctx.finalSourceFolderId = processingFolderId ?? resolvedConfig.drivePendingFolderId;
  return { kind: "continue" };
}

/** 2. Deduplicación por hash SHA256 del binario. */
async function dedupHashStep(ctx: PipelineContext): Promise<StepResult> {
  const { invoiceRepository } = ctx.deps;
  const cid = ctx.deps.resolvedConfig.clientId;

  ctx.fileHash = invoiceRepository.computeDocumentHash(ctx.buffer!);
  ctx.existingByHash = await ctx.runStep(
    "Verificación duplicado por hash",
    () => invoiceRepository.findDuplicateByHash(cid, ctx.fileHash),
    "dedupHash"
  );
  pipelineLog.hashResult(cid, ctx.fileHash, Boolean(ctx.existingByHash));
  ctx.isDuplicate = Boolean(ctx.existingByHash);
  return { kind: "continue" };
}

/** Deriva un documento no-boleta a Revisión con prefijo [NO BOLETA] (sin Sheets/DB). */
async function divertNotBoleta(ctx: PipelineContext, layer: "heuristic" | "ai"): Promise<StepResult> {
  const { file } = ctx;
  const { resolvedConfig, driveService } = ctx.deps;
  const m = ctx.m;
  const cid = resolvedConfig.clientId;
  const finalSourceFolderId = ctx.finalSourceFolderId;

  m.result = "not_boleta";
  m.reason = layer;
  pipelineLog.stepStart(cid, `🚫 No es boleta (${layer}) → Revisión [NO BOLETA]: "${file.name}"`);
  if (resolvedConfig.driveFailedFolderId && finalSourceFolderId) {
    await ctx.runStep("Renombrar [NO BOLETA]", () => driveService.renameFile(file.id, markNotBoleta(file.name)), "move");
    await ctx.runStep(
      "Mover a Revisión (no boleta)",
      () => driveService.moveFileToFolder(file.id, finalSourceFolderId, resolvedConfig.driveFailedFolderId!),
      "move"
    );
    pipelineLog.movedToFailed(cid, file.id);
  }
  ctx.summary.notBoleta = (ctx.summary.notBoleta ?? 0) + 1;
  pipelineLog.fileCompleted(cid, file.name, { processed: 0, unassigned: 0, duplicate: false }, "NO BOLETA → Revisión");
  return { kind: "halt", result: m.result, reason: m.reason };
}

/** 3.5 (capa 1) Triage por heurística sobre el texto, ANTES de la IA (ahorra tokens). */
async function documentTriageGate(ctx: PipelineContext): Promise<StepResult> {
  // Sin texto (imágenes) la heurística no aplica → decide la capa 2 (isBoletaGate).
  if (!ctx.docText) return { kind: "continue" };
  if (classifyDocumentType(ctx.docText) === "not_boleta") {
    return divertNotBoleta(ctx, "heuristic");
  }
  return { kind: "continue" };
}

/** 3a. Extracción de TEXTO (pdf-parse + detección LSP). Sin tokens de IA. */
async function textExtractStep(ctx: PipelineContext): Promise<StepResult> {
  const { file } = ctx;
  const { resolvedConfig, pdfExtractor } = ctx.deps;
  const m = ctx.m;
  const runStep = ctx.runStep;
  const cid = resolvedConfig.clientId;
  const buffer = ctx.buffer!;

  // Detectar si el archivo es una imagen (JPG/PNG)
  const isImage = (
    file.mimeType?.startsWith("image/") ||
    /\.(jpg|jpeg|png)$/i.test(file.name)
  );
  ctx.isImage = isImage;

  if (isImage) {
    // Las imágenes no tienen texto extraíble → la extracción es vía Vision (aiExtractStep).
    pipelineLog.stepStart(cid, `→ Archivo de imagen detectado (${file.mimeType ?? file.name}) — usando Gemini Vision`);
    m.textSource = "image";
    m.textChars = 0;
    m.emitterBlock = false;
    ctx.docText = "";
    ctx.lspProvider = null;
    return { kind: "continue" };
  }

  if (ctx.existingByHash?.extraction) {
    // Duplicado por hash con extracción previa: solo extraemos texto (para refine + detección).
    const text = await runStep("Extracción de texto (PDF)", () => pdfExtractor.extractTextFromPdf(buffer), "text");
    m.textSource = pdfExtractor.getLastTextSource();
    m.textChars = text.length;
    m.emitterBlock = pdfExtractor.getLastHasEmitterBlock();
    m.ms.ocr = pdfExtractor.getLastOcrMs();
    ctx.docText = text;
    ctx.lspProvider = identifyLSPProvider(text);
    return { kind: "continue" };
  }

  // Flujo normal: texto completo para detección.
  const fullText = await runStep("Extracción de texto (PDF)", () => pdfExtractor.extractTextFromPdf(buffer), "text");
  m.textSource = pdfExtractor.getLastTextSource();
  m.textChars = fullText.length;
  m.emitterBlock = pdfExtractor.getLastHasEmitterBlock();
  m.ms.ocr = pdfExtractor.getLastOcrMs();

  const lspProvider = identifyLSPProvider(fullText);
  if (lspProvider) {
    pipelineLog.lspDetected(cid, lspProvider);
  }

  // Para LSP, re-extraer limitando a página 1 para reducir ruido.
  // ARCA F931: el total a pagar está en el VEP (página 2) → re-extraer 2 páginas, no 1.
  const lspMaxPages = lspProvider === "ARCA" ? 2 : 1;
  const text = lspProvider
    ? await runStep("Re-extracción LSP (página 1+)", () => pdfExtractor.extractTextFromPdf(buffer, lspMaxPages), "textPage1")
    : fullText;
  ctx.docText = text;
  ctx.lspProvider = lspProvider;

  if (resolvedConfig.debugMode) {
    pipelineLog.stepStart(cid, `[DEBUG-OCR] texto (${text.length} chars, sanitizado):\n${safeDebugLog(text)}`);
  }
  return { kind: "continue" };
}

/** 3b. Extracción de DATOS por IA (Vision / cacheado / cadena IA sobre el texto). */
async function aiExtractStep(ctx: PipelineContext): Promise<StepResult> {
  const { file, summary } = ctx;
  const { resolvedConfig, geminiModule, aiChain, geminiApiKey, geminiModel } = ctx.deps;
  const m = ctx.m;
  const runStep = ctx.runStep;
  const cid = resolvedConfig.clientId;
  const buffer = ctx.buffer!;
  const existingByHash = ctx.existingByHash;
  const docText = ctx.docText;
  const lspProvider = ctx.lspProvider;

  let extracted: ExtractedDocumentData | null = null;
  let fileAiUsage: import("@/types/aiUsage.types").AiUsageMetrics | null = null;
  let extractionWasCached = false;

  if (ctx.isImage) {
    // ── Flujo imagen: extracción directa con Gemini Vision ──
    if (existingByHash?.extraction) {
      const { sourceFileUrl: _url, isDuplicate: _dup, ...storedFields } =
        existingByHash.extraction as ExtractedDocumentData;
      extracted = { ...storedFields };
      extractionWasCached = true;
    } else if (geminiModule && geminiApiKey) {
      const imageMimeType: "image/jpeg" | "image/png" =
        file.mimeType?.includes("png") ? "image/png" : "image/jpeg";
      try {
        const extractor = new geminiModule.GeminiExtractorService({ apiKey: geminiApiKey, model: geminiModel });
        extracted = await runStep(
          "Extracción IA (Gemini Vision)",
          () => extractor.extractStructuredDataFromImage(buffer, imageMimeType),
          "ai"
        );
        fileAiUsage = extractor.getLastUsage?.() ?? null;
        accumulateTokenUsage(summary.tokenUsage, fileAiUsage);
        pipelineLog.aiExtraction(cid, "gemini", true);
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Gemini Vision error";
        pipelineLog.aiExtraction(cid, "gemini", false, msg);
        // Sin cuota (429): dejar la imagen en Pendientes para reintento posterior.
        if (isRateLimitError(error)) {
          throw new RateLimitError("IA Vision sin cuota (429)");
        }
        extracted = buildOcrOnlyPayload();
      }
    } else {
      pipelineLog.stepStart(cid, "⚠️ Imagen sin Gemini configurado — no se puede procesar");
      extracted = buildOcrOnlyPayload();
    }

    if (resolvedConfig.debugMode && extracted) {
      pipelineLog.stepStart(cid, `[DEBUG-AI] respuesta raw (sanitizada): ${safeDebugLog(JSON.stringify(extracted))}`);
    }
  } else if (existingByHash?.extraction) {
    // ── Flujo PDF: duplicado por hash con extracción previa ──
    const { sourceFileUrl: _url, isDuplicate: _dup, ...storedFields } =
      existingByHash.extraction as ExtractedDocumentData;
    extracted = { ...storedFields };
    extractionWasCached = true;
    extracted = refineExtractionWithRawText(extracted, docText);
  } else {
    // ── Flujo PDF: extracción normal vía cadena IA sobre el texto ya extraído ──
    // Fallback IA Gemini→OpenAI→Claude vía cadena reutilizable. El logging
    // por intento se inyecta vía callback; el timing acumulado ("ai") lo
    // mantiene runStep envolviendo la ejecución completa de la cadena.
    // El flag rateLimited viene clasificado por la CADENA sobre el objeto del
    // error (instanceof) — no re-parsear acá el texto del mensaje (bug real:
    // el mensaje en español "sin cuota" no matcheaba "quota" y las boletas
    // caían a OCR_ONLY → "SIN MONTO" → Revisión en vez de Pendientes).
    let aiFailures = 0;
    let aiRateLimited = 0;
    const aiResult = await runStep(
      "Extracción IA",
      () =>
        aiChain.run(docText, (provider, ok, errorMsg, rateLimited) => {
          pipelineLog.aiExtraction(cid, provider, ok, errorMsg);
          if (!ok) {
            aiFailures += 1;
            if (rateLimited) aiRateLimited += 1;
          }
        }),
      "ai"
    );

    if (aiResult) {
      extracted = aiResult.data;
      fileAiUsage = aiResult.usage;
      accumulateTokenUsage(summary.tokenUsage, fileAiUsage);
    } else if (aiFailures > 0 && aiRateLimited === aiFailures) {
      // Todos los proveedores de IA sin cuota (429): NO degradar a OCR_ONLY
      // (terminaría en Revisión). Se propaga como RateLimitError para dejar
      // la boleta en Pendientes y reintentarla en un ciclo posterior.
      throw new RateLimitError(`IA sin cuota — ${aiFailures} proveedor(es) en 429`);
    } else {
      pipelineLog.aiOcrFallback(cid);
      extracted = buildOcrOnlyPayload();
    }

    if (resolvedConfig.debugMode && extracted) {
      pipelineLog.stepStart(cid, `[DEBUG-AI] respuesta raw (sanitizada): ${safeDebugLog(JSON.stringify(extracted))}`);
    }
  }

  if (extracted === null) throw new Error("extraction produced no result unexpectedly");

  pipelineLog.extractionResult(cid, {
    consortium: extracted.consortium,
    provider: extracted.provider,
    providerTaxId: extracted.providerTaxId,
    amount: extracted.amount,
    dueDate: extracted.dueDate,
    allTaxIds: extracted.allTaxIds,
  });

  // Metadatos de extracción para [metrics]: lsp + tokens/modelo + snapshot crudo
  // (lo que extrajo la IA, ANTES de canonizar). El snapshot va al bloque `values`
  // (solo se emite con debugMode).
  m.lsp = lspProvider ?? null;
  m.ai = fileAiUsage
    ? {
        provider: fileAiUsage.provider ?? null,
        model: fileAiUsage.model ?? null,
        ok: true,
        in: fileAiUsage.inputTokens ?? null,
        out: fileAiUsage.outputTokens ?? null,
        total: fileAiUsage.totalTokens ?? null,
      }
    : { provider: extractionWasCached ? "cached" : "ocr_only", model: null, ok: false, in: null, out: null, total: null };
  m.extracted = {
    consortium: extracted.consortium,
    provider: extracted.provider,
    taxId: extracted.providerTaxId,
    boleta: extracted.boletaNumber,
    due: extracted.dueDate,
    amount: extracted.amount,
    clientNumber: extracted.clientNumber,
  };

  ctx.extracted = extracted;
  ctx.fileAiUsage = fileAiUsage;
  ctx.extractionWasCached = extractionWasCached;
  return { kind: "continue" };
}

/** 3.6 (capa 2) Triage por IA: si la extracción marcó isBoleta=false, deriva a [NO BOLETA]. */
async function isBoletaGate(ctx: PipelineContext): Promise<StepResult> {
  if (ctx.extracted?.isBoleta === false) {
    return divertNotBoleta(ctx, "ai");
  }
  return { kind: "continue" };
}

/** 4. Gate "sin monto": sin importe extraíble → Revisión (SIN MONTO). */
async function missingAmountGate(ctx: PipelineContext): Promise<StepResult> {
  const { file } = ctx;
  const { resolvedConfig, driveService } = ctx.deps;
  const m = ctx.m;
  const cid = resolvedConfig.clientId;
  const extracted = ctx.extracted!;
  const finalSourceFolderId = ctx.finalSourceFolderId;

  // ── Gate "sin monto": sin importe (certificados, obleas, informes) o monto no
  // extraíble → Revisión con tag SIN MONTO. `0` es válido (boletas LSP de $0) y NO
  // cae acá. No se escribe en Sheets ni se guarda Invoice.
  if (isMissingAmount(extracted.amount)) {
    m.result = "no_amount";
    m.reason = "no_amount";
    pipelineLog.stepStart(cid, `⚠️ Sin monto → Revisión (SIN MONTO): "${file.name}"`);
    if (resolvedConfig.driveFailedFolderId && finalSourceFolderId) {
      await ctx.runStep("Renombrar (SIN MONTO)", () => driveService.renameFile(file.id, appendNoAmountTag(file.name)), "move");
      await ctx.runStep(
        "Mover a Revisión (sin monto)",
        () => driveService.moveFileToFolder(file.id, finalSourceFolderId, resolvedConfig.driveFailedFolderId!),
        "move"
      );
      pipelineLog.movedToFailed(cid, file.id);
    }
    ctx.summary.unassigned += 1;
    pipelineLog.fileCompleted(cid, file.name, { processed: 0, unassigned: 1, duplicate: false }, "SIN MONTO → Revisión");
    return { kind: "halt", result: m.result, reason: m.reason };
  }
  return { kind: "continue" };
}

/** 5. Saneo de CUIT inventado (NO-LSP) + agregado de CUITs reales del texto. */
async function cuitSanitizeStep(ctx: PipelineContext): Promise<StepResult> {
  const cid = ctx.deps.resolvedConfig.clientId;
  const extracted = ctx.extracted!;
  const lspProvider = ctx.lspProvider;
  const docText = ctx.docText;

  // Boletas sindicales (SUTERH/FATERYH/SERACARH): el CUIT del papel es del
  // CONSORCIO (no del sindicato) → mismo tratamiento determinístico que un
  // documento no-LSP para el matching del edificio.
  const isSindical = usesConsortiumCuit(lspProvider);

  // ── Saneo de CUIT inventado (solo NO-LSP): si la IA devolvió un CUIT que no
  // está en el texto del documento, se descarta (era alucinado). LSP de
  // servicios se excluye: su CUIT viene del prompt (no del papel).
  if (lspProvider === null && docText) {
    if (extracted.providerTaxId && !cuitAppearsInText(extracted.providerTaxId, docText)) {
      pipelineLog.stepStart(cid, `⚠️ CUIT descartado: no aparece en el texto del documento (probable invención de la IA)`);
      extracted.providerTaxId = null;
    }
    if (Array.isArray(extracted.allTaxIds) && extracted.allTaxIds.length > 0) {
      extracted.allTaxIds = extracted.allTaxIds.filter((c) => cuitAppearsInText(c, docText));
    }
  }

  // ── CUITs reales del texto por regex + checksum (NO-LSP y sindicales) ──────
  // Refuerzo determinístico: la IA puede omitir/malformatear el CUIT. En
  // sindicales es el del CONSORCIO y es crítico para imputar el gasto al
  // edificio correcto. El matching ya excluye el CUIT del consorcio del
  // proveedor, así que sumar todos los CUITs del papel es seguro.
  if ((lspProvider === null || isSindical) && docText) {
    const textCuits = extractCuitsFromText(docText);
    if (textCuits.length > 0) {
      const merged = new Set([
        ...(extracted.allTaxIds ?? []).map((c) => formatCuit(c) ?? c),
        ...textCuits.map((c) => formatCuit(c) ?? c),
      ]);
      extracted.allTaxIds = [...merged];
      pipelineLog.stepStart(cid, `→ CUITs del texto (regex+checksum): ${textCuits.length} — allTaxIds total: ${extracted.allTaxIds.length}`);
    }
  }
  return { kind: "continue" };
}

/** 6. Deduplicación por clave de negocio (DB + claves ya vistas en esta corrida). */
async function businessKeyDedupStep(ctx: PipelineContext): Promise<StepResult> {
  const { invoiceRepository, existingDuplicateKeys } = ctx.deps;
  const cid = ctx.deps.resolvedConfig.clientId;
  const extracted = ctx.extracted!;

  if (!ctx.isDuplicate) {
    const dup = await ctx.runStep(
      "Verificación duplicado por clave de negocio",
      () => invoiceRepository.findDuplicateByBusinessKey(cid, extracted),
      "dedupKey"
    );
    if (dup) {
      ctx.isDuplicate = true;
      pipelineLog.duplicateByBusinessKey(cid);
    }
  }

  const duplicateKey = invoiceRepository.buildBusinessKeyFromData(extracted);
  ctx.duplicateKey = duplicateKey;
  if (!ctx.isDuplicate && duplicateKey) {
    if (existingDuplicateKeys.has(duplicateKey)) {
      ctx.isDuplicate = true;
      pipelineLog.duplicateByBusinessKey(cid);
    }
  }
  return { kind: "continue" };
}

/** 7. Limpieza de clientNumber (exclusivo de LSP) + flags base en `extracted`. */
async function cleanClientNumberStep(ctx: PipelineContext): Promise<StepResult> {
  const cid = ctx.deps.resolvedConfig.clientId;
  const extracted = ctx.extracted!;

  // Guard: clientNumber es exclusivo de boletas LSP.
  // Si la IA alucinó un valor para una boleta normal, limpiarlo.
  if (!ctx.lspProvider && extracted.clientNumber) {
    pipelineLog.stepStart(cid,
      `⚠️  clientNumber limpiado para boleta no-LSP (era "${extracted.clientNumber}")`
    );
    extracted.clientNumber = null;
  }

  extracted.sourceFileUrl = ctx.sourceFileUrl;
  extracted.isDuplicate = ctx.isDuplicate ? "YES" : "NO";
  extracted.paymentStatus = "Sin pagar";
  return { kind: "continue" };
}

/** 8. Matching consorcio + proveedor + período (con fallback visual del emisor). */
async function assignmentStep(ctx: PipelineContext): Promise<StepResult> {
  const { file } = ctx;
  const {
    consortiumRepository, providerRepository, lspServiceRepository,
    pdfExtractor, geminiModule, geminiApiKey, geminiModel,
  } = ctx.deps;
  const m = ctx.m;
  const cid = ctx.deps.resolvedConfig.clientId;
  const extracted = ctx.extracted!;
  const lspProvider = ctx.lspProvider;

  const assignStart = Date.now();
  let assignment = await resolveAssignment(
    extracted, cid, file.id, consortiumRepository, providerRepository, lspServiceRepository, lspProvider
  );
  m.ms.assign = Date.now() - assignStart;

  // ── Fallback visual: si el proveedor no fue encontrado y el emisor
  // estaba en imagen, intentar extracción visual con Gemini ──────────────
  if (
    assignment.unassigned &&
    assignment.consortiumId &&
    !pdfExtractor.getLastHasEmitterBlock() &&
    geminiModule &&
    geminiApiKey
  ) {
    const pngBuffer = pdfExtractor.getLastOcrPng();
    if (pngBuffer) {
      try {
        pipelineLog.stepStart(cid, "→ Fallback visual: extrayendo emisor con Gemini Vision...");
        const visualExtractor = new geminiModule.GeminiExtractorService({
          apiKey: geminiApiKey,
          model: geminiModel,
        });
        const visualResult = await visualExtractor.extractProviderFromImage(
          pngBuffer,
          assignment.canonicalConsortium ?? extracted.consortium ?? ""
        );

        if (visualResult.providerTaxId || visualResult.providerName) {
          pipelineLog.stepStart(cid,
            `→ Gemini Vision extrajo: provider="${visualResult.providerName}" ` +
            `taxId="${visualResult.providerTaxId}"`
          );

          if (visualResult.providerTaxId) {
            extracted.providerTaxId = visualResult.providerTaxId;
          }
          if (visualResult.providerName) {
            extracted.provider = visualResult.providerName;
          }

          const visualAssignment = await resolveAssignment(
            extracted, cid, file.id, consortiumRepository, providerRepository, lspServiceRepository, lspProvider
          );

          if (!visualAssignment.unassigned) {
            pipelineLog.stepStart(cid, "✅ Fallback visual: proveedor encontrado");
            assignment = visualAssignment;
          } else {
            pipelineLog.stepStart(cid,
              `⚠️ Fallback visual: proveedor no encontrado en DB ` +
              `(${visualResult.providerName} / ${visualResult.providerTaxId})`
            );
          }
        } else {
          pipelineLog.stepStart(cid, "⚠️ Fallback visual: Gemini Vision no pudo extraer el emisor");
        }
      } catch (visualError) {
        pipelineLog.stepStart(cid,
          `⚠️ Fallback visual falló silenciosamente: ${visualError instanceof Error ? visualError.message : "error"}`
        );
      }
    }
  }
  // ── Fin fallback visual ────────────────────────────────────────────────

  m.match = { consortium: assignment.consortiumMatchMethod, provider: assignment.providerMatchMethod };
  ctx.assignment = assignment;
  return { kind: "continue" };
}

/** 9. Canonización: reemplaza datos OCR por los canónicos de DB en `extracted`. */
async function canonizeStep(ctx: PipelineContext): Promise<StepResult> {
  const cid = ctx.deps.resolvedConfig.clientId;
  const m = ctx.m;
  const extracted = ctx.extracted!;
  const assignment = ctx.assignment!;

  if (!assignment.unassigned) {
    if (assignment.canonicalConsortium)    extracted.consortium    = assignment.canonicalConsortium;
    if (assignment.canonicalProvider)      extracted.provider      = assignment.canonicalProvider;
    // SERACARH (anexo de FATERYH) → mismo providerId, pero se anota "(SERACARH)" en el
    // texto para distinguir las 2 boletas FATERYH del consorcio en Sheets, el nombre
    // del archivo en Drive y la DB.
    extracted.provider = annotateSindicalProvider(extracted.provider, ctx.lspProvider);
    extracted.alias = assignment.providerPaymentAlias || null;
    if (assignment.canonicalProviderTaxId) extracted.providerTaxId = assignment.canonicalProviderTaxId;
    extracted.period = assignment.periodLabel || null;
    extracted.bank = assignment.consortiumBank;
    pipelineLog.canonized(cid, extracted.consortium ?? "?", extracted.provider ?? "?", extracted.providerTaxId ?? "?");
    m.canonical = {
      consortium: extracted.consortium,
      provider: extracted.provider,
      taxId: extracted.providerTaxId,
      period: extracted.period,
    };
  }
  return { kind: "continue" };
}

/** 10. Gate "sin asignar": no matcheó consorcio/proveedor → Sin Asignar. */
async function unassignedGate(ctx: PipelineContext): Promise<StepResult> {
  const { file } = ctx;
  const { resolvedConfig, driveService } = ctx.deps;
  const m = ctx.m;
  const cid = resolvedConfig.clientId;
  const assignment = ctx.assignment!;
  const finalSourceFolderId = ctx.finalSourceFolderId;

  if (assignment.unassigned) {
    m.result = "unassigned";
    m.reason = assignment.reasonCategory ?? null;
    m.reasonText = assignment.unassignedReason;
    pipelineLog.movedToUnassigned(cid, file.id, assignment.unassignedReason ?? "razón desconocida");
    if (resolvedConfig.driveUnassignedFolderId && finalSourceFolderId) {
      await ctx.runStep(
        "Mover a Sin Asignar",
        () => driveService.moveFileToUnassigned(file.id, finalSourceFolderId, resolvedConfig.driveUnassignedFolderId!),
        "move"
      );
    }
    ctx.summary.unassigned += 1;
    pipelineLog.fileCompleted(cid, file.name, { processed: 0, unassigned: 1, duplicate: false });
    return { kind: "halt", result: m.result, reason: m.reason };
  }
  return { kind: "continue" };
}

/** 11. Gate "sin período activo": consorcio OK pero sin período + statements → Revisión. */
async function noPeriodGate(ctx: PipelineContext): Promise<StepResult> {
  const { file } = ctx;
  const { resolvedConfig, driveService } = ctx.deps;
  const m = ctx.m;
  const cid = resolvedConfig.clientId;
  const assignment = ctx.assignment!;
  const finalSourceFolderId = ctx.finalSourceFolderId;

  // Red de seguridad (caso puntual): el consorcio matcheó pero no tiene período
  // activo. El peor caso —cliente sin ningún período— ya lo cortó la llave del
  // scheduler (0 tokens). Esta boleta puntual va a Revisión (failed) + aviso: no
  // se organiza en Rendiciones, no se escribe en Sheets ni en DB. Solo aplica si
  // la organización por Rendiciones está activa (statements configurada).
  if (!ctx.isDuplicate && resolvedConfig.driveStatementsFolderId && !assignment.periodId) {
    m.result = "no_period";
    m.reason = "no_active_period";
    pipelineLog.stepStart(cid, `⚠️ Consorcio "${assignment.canonicalConsortium ?? "?"}" sin período activo → Revisión`);
    if (resolvedConfig.driveFailedFolderId && finalSourceFolderId) {
      await ctx.runStep(
        "Mover a Revisión (sin período activo)",
        () => driveService.moveFileToFolder(file.id, finalSourceFolderId, resolvedConfig.driveFailedFolderId!),
        "move"
      );
      pipelineLog.movedToFailed(cid, file.id);
    }
    ctx.summary.unassigned += 1;
    pipelineLog.fileCompleted(cid, file.name, { processed: 0, unassigned: 1, duplicate: false }, "SIN PERÍODO ACTIVO → Revisión");
    return { kind: "halt", result: m.result, reason: m.reason };
  }
  return { kind: "continue" };
}

/** 12. Inserción en Google Sheets (solo si NO es duplicado). */
async function sheetsStep(ctx: PipelineContext): Promise<StepResult> {
  const { resolvedConfig, sheetsService, resolvedMapping } = ctx.deps;
  const cid = resolvedConfig.clientId;
  const extracted = ctx.extracted!;

  // Duplicados: NO se escriben en Sheets ni en DB — así la planilla y la DB
  // se mantienen 1:1. El PDF se mueve a la carpeta "Duplicados" si está
  // configurada; si no, a Escaneados (no se pierde, queda para revisión).
  if (!ctx.isDuplicate) {
    await ctx.runStep(
      "Insertar en Google Sheets",
      () => sheetsService.insertRow(resolvedConfig.sheetName, extracted, resolvedMapping),
      "sheets"
    );
    pipelineLog.sheetsInserted(cid);
  } else {
    pipelineLog.stepStart(cid, "📋 Duplicado — no se escribe en Sheets (consistencia DB↔Sheets)");
  }
  return { kind: "continue" };
}

/** 13. Organización del archivo en Drive (Duplicados / Rendiciones / Escaneados). */
async function fileOrganizationStep(ctx: PipelineContext): Promise<StepResult> {
  const { file } = ctx;
  const { resolvedConfig, driveService } = ctx.deps;
  const cid = resolvedConfig.clientId;
  const extracted = ctx.extracted!;
  const assignment = ctx.assignment!;
  const finalSourceFolderId = ctx.finalSourceFolderId;
  const fileHash = ctx.fileHash;

  if (ctx.isDuplicate && resolvedConfig.driveDuplicatesFolderId && finalSourceFolderId) {
    const fromFolder = finalSourceFolderId;
    const dupFolder = resolvedConfig.driveDuplicatesFolderId;
    await ctx.runStep(
      "Mover a Duplicados",
      () => driveService.moveFileToFolder(file.id, fromFolder, dupFolder),
      "move"
    );
    pipelineLog.stepStart(cid, "→ Duplicado movido a carpeta Duplicados");
  } else if (!ctx.isDuplicate && resolvedConfig.driveStatementsFolderId && finalSourceFolderId) {
    // Boleta OK → organizar en Rendiciones/[Edificio]/[Período] (reemplaza
    // Escaneados). La carpeta del edificio se crea/comparte la primera vez.
    const resolveStatementsFolders =
      ctx.deps.resolveStatementsFolders ??
      (await import("@/services/statementsFolders.service")).resolveStatementsFolders;
    const buildInvoiceFileName =
      ctx.deps.buildInvoiceFileName ??
      (await import("@/lib/statementsNaming")).buildInvoiceFileName;
    const sf = await ctx.runStep(
      "Resolver carpetas Rendiciones",
      () => resolveStatementsFolders({
        drive: driveService,
        statementsRootId: resolvedConfig.driveStatementsFolderId!,
        consortium: {
          id: assignment.consortiumId!,
          rawName: assignment.canonicalConsortium ?? assignment.consortiumId!,
          statementsFolderId: assignment.statementsFolderId,
        },
        month: assignment.periodMonth!,
        year: assignment.periodYear!,
      }),
      "move"
    );
    const newName = buildInvoiceFileName({
      provider: extracted.provider,
      consortium: assignment.canonicalConsortium,
      month: assignment.periodMonth!,
      year: assignment.periodYear!,
      boletaNumber: extracted.boletaNumber,
      documentHash: fileHash,
    });
    await ctx.runStep("Renombrar boleta", () => driveService.renameFile(file.id, newName), "move");
    await ctx.runStep(
      "Mover a Rendiciones",
      () => driveService.moveFileToFolder(file.id, finalSourceFolderId, sf.periodFolderId),
      "move"
    );
    pipelineLog.stepStart(cid, `📁 Organizada en Rendiciones — "${assignment.canonicalConsortium ?? "?"}"`);
  } else {
    // Fallback legacy (no debería ocurrir: el scheduler valida statements).
    await ctx.runStep(
      "Mover a Escaneados",
      () => driveService.moveFileToScanned(file.id, finalSourceFolderId, resolvedConfig.driveScannedFolderId),
      "move"
    );
    pipelineLog.movedToScanned(cid, file.id);
  }
  return { kind: "continue" };
}

/** 14. Persistencia: guarda Invoice (solo si NO es dup) + actualiza summary y `m.result`. */
async function persistStep(ctx: PipelineContext): Promise<StepResult> {
  const { file } = ctx;
  const { invoiceRepository, existingDuplicateKeys } = ctx.deps;
  const m = ctx.m;
  const cid = ctx.deps.resolvedConfig.clientId;
  const extracted = ctx.extracted!;
  const assignment = ctx.assignment!;
  const fileHash = ctx.fileHash;
  const fileAiUsage = ctx.fileAiUsage;
  const isDuplicate = ctx.isDuplicate;
  const duplicateKey = ctx.duplicateKey;
  const sourceFileUrl = ctx.sourceFileUrl;

  const { sourceFileUrl: _url, isDuplicate: _dup, ...extractionFields } = extracted;

  if (!isDuplicate) {
    await ctx.runStep(
      "Guardar invoice",
      () => invoiceRepository.saveProcessedInvoice({
        clientId: cid, documentHash: fileHash, fileId: file.id,
        sourceFileUrl, extraction: extractionFields, isDuplicate,
        consortiumId: assignment.consortiumId, providerId: assignment.providerId, periodId: assignment.periodId,
        lspServiceId: assignment.lspServiceId, paymentMethod: extracted.paymentMethod,
        tokensInput: fileAiUsage?.inputTokens ?? null,
        tokensOutput: fileAiUsage?.outputTokens ?? null,
        tokensTotal: fileAiUsage?.totalTokens ?? null,
        aiProvider: fileAiUsage?.provider ?? null,
        aiModel: fileAiUsage?.model ?? null,
      }),
      "save"
    );
    pipelineLog.invoiceSaved(cid, isDuplicate);
  } else {
    pipelineLog.stepStart(cid, "📋 Duplicado — no se guarda en DB");
  }

  if (duplicateKey) existingDuplicateKeys.add(duplicateKey);
  if (isDuplicate)  ctx.summary.duplicatesDetected += 1;
  ctx.summary.processed += 1;
  m.result = isDuplicate ? "duplicate" : "ok";
  m.reason = null;
  pipelineLog.fileCompleted(cid, file.name, { processed: 1, unassigned: 0, duplicate: isDuplicate });
  return { kind: "halt", result: m.result, reason: m.reason };
}

export async function processDriveFile(
  file: ProcessDriveFileInput,
  context: ProcessingContext,
  summary: ProcessJobSummary
): Promise<void> {
  // Thin wrapper: arma el PipelineContext y delega en el runner, que orquesta
  // los pasos, corta al primer `halt` y centraliza errores + emisión de [metrics].
  const ctx = createPipelineContext(file, context, summary);
  await runPipeline(
    [
      downloadAndLockStep,
      dedupHashStep,
      textExtractStep,
      documentTriageGate,
      aiExtractStep,
      isBoletaGate,
      missingAmountGate,
      cuitSanitizeStep,
      businessKeyDedupStep,
      cleanClientNumberStep,
      assignmentStep,
      canonizeStep,
      unassignedGate,
      noPeriodGate,
      sheetsStep,
      fileOrganizationStep,
      persistStep,
    ],
    ctx
  );
}

function buildLegacyConfig(sheetName: string, mapping?: SheetsRowMapping): ProcessJobConfig {
  return {
    clientId: "default-env-client", clientName: "Default Client", sheetName, mapping,
    drivePendingFolderId: env.GOOGLE_DRIVE_PENDING_FOLDER_ID,
    driveScannedFolderId: env.GOOGLE_DRIVE_SCANNED_FOLDER_ID,
    driveUnassignedFolderId: null, driveFailedFolderId: null, driveProcessingFolderId: null, driveDuplicatesFolderId: null, driveStatementsFolderId: null, googleConfig: null,
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
    driveProcessingFolderId: config.driveProcessingFolderId ?? null,
    driveDuplicatesFolderId: config.driveDuplicatesFolderId ?? null,
    driveStatementsFolderId: config.driveStatementsFolderId ?? null,
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

  pipelineLog.batchStart(resolvedConfig.clientId, resolvedConfig.clientName, resolvedConfig.drivePendingFolderId ?? "?", files.length);

  if (resolvedConfig.debugMode) {
    pipelineLog.stepStart(
      resolvedConfig.clientId,
      "⚠️  [DEBUG MODE ACTIVO] Los logs incluyen contenido sensible " +
      "(OCR completo, respuestas IA, CUITs, importes). " +
      "Desactivar en producción cuando no sea necesario."
    );
  }

  const summary = createBaseSummary(files.length);
  summary.clientId = resolvedConfig.clientId;
  summary.clientName = resolvedConfig.clientName;

  for (const file of files) {
    if (processedIds.has(file.id)) { summary.skipped += 1; continue; }
    processedIds.add(file.id);
    await processDriveFile({ id: file.id, name: file.name, mimeType: file.mimeType, webViewLink: file.webViewLink }, context, summary);
  }

  pipelineLog.batchSummary(resolvedConfig.clientId, {
    totalFound: summary.totalFound,
    processed: summary.processed,
    unassigned: summary.unassigned,
    failed: summary.failed,
    duplicatesDetected: summary.duplicatesDetected,
    notBoleta: summary.notBoleta,
  });

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
