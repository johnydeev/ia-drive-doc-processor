import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  processDriveFile,
  createBaseSummary,
  DEFAULT_MAPPING,
  type ProcessingContext,
} from "@/jobs/processPendingDocuments.job";
import type { ProcessJobConfig, ProcessDriveFileInput } from "@/jobs/processPendingDocuments.job";
import type { AiAttemptCallback, AiExtractionResult } from "@/services/aiExtraction";
import { pipelineLog } from "@/lib/logger";
import { ExtractedDocumentData } from "@/types/extractedDocument.types";

/**
 * Tests de CARACTERIZACIÓN de `processDriveFile` (red de seguridad del refactor
 * H2). Documentan el comportamiento OBSERVABLE actual de los 7 caminos de salida
 * — qué métodos de Drive/Sheets/Repo se llaman y el `summary`/`result` resultante.
 * Deben pasar idénticos ANTES y DESPUÉS de descomponer el pipeline en pasos.
 *
 * Las dependencias se inyectan vía un `ProcessingContext` con todos los métodos
 * como `vi.fn()`. La lógica PURA intermedia (identifyLSPProvider, isMissingAmount,
 * matchConsortium/matchProvider, etc.) corre de verdad — por eso los inputs están
 * elegidos para enrutar a cada camino.
 */

function emptyExtraction(overrides: Partial<ExtractedDocumentData> = {}): ExtractedDocumentData {
  return {
    boletaNumber: null,
    provider: null,
    consortium: null,
    providerTaxId: null,
    detail: null,
    observation: null,
    dueDate: null,
    amount: null,
    alias: null,
    clientNumber: null,
    paymentMethod: null,
    allTaxIds: [],
    ...overrides,
  };
}

function makeFile(over: Partial<ProcessDriveFileInput> = {}): ProcessDriveFileInput {
  return { id: "file-1", name: "boleta.pdf", mimeType: "application/pdf", webViewLink: null, ...over };
}

/** Datos extraídos por IA que matchean el consorcio/proveedor sembrados en makeContext. */
function okExtraction(over: Partial<ExtractedDocumentData> = {}): ExtractedDocumentData {
  return emptyExtraction({
    consortium: "THAMES 647",
    provider: "TIGRE ASCENSORES S.A.",
    amount: 118000,
    boletaNumber: "0001",
    dueDate: "2026-05-10",
    providerTaxId: null,
    allTaxIds: [],
    ...over,
  });
}

/**
 * Arma un ProcessingContext con deps mockeadas. Por defecto enruta al camino OK:
 * sin duplicado, IA devuelve datos válidos, consorcio + proveedor + período activo
 * matchean. Cada test ajusta los mocks puntuales para enrutar a su camino.
 */
function makeContext(configOver: Partial<ProcessJobConfig> = {}) {
  const config: ProcessJobConfig = {
    clientId: "client-1",
    clientName: "Test Client",
    sheetName: "Datos",
    drivePendingFolderId: "pending",
    driveScannedFolderId: "scanned",
    driveUnassignedFolderId: "unassigned",
    driveFailedFolderId: "failed",
    driveProcessingFolderId: null,
    driveDuplicatesFolderId: "duplicates",
    driveStatementsFolderId: "statements",
    ...configOver,
  };

  const driveService = {
    downloadFile: vi.fn().mockResolvedValue(Buffer.from("pdf-bytes")),
    moveFileToFolder: vi.fn().mockResolvedValue(undefined),
    moveFileToUnassigned: vi.fn().mockResolvedValue(undefined),
    moveFileToScanned: vi.fn().mockResolvedValue(undefined),
    moveFileToFailed: vi.fn().mockResolvedValue(undefined),
    renameFile: vi.fn().mockResolvedValue(undefined),
  };

  const pdfExtractor = {
    extractTextFromPdf: vi.fn().mockResolvedValue("documento de prueba importe total a pagar"),
    getLastTextSource: vi.fn().mockReturnValue("direct"),
    getLastHasEmitterBlock: vi.fn().mockReturnValue(true),
    getLastOcrMs: vi.fn().mockReturnValue(0),
    getLastOcrPng: vi.fn().mockReturnValue(null),
  };

  const sheetsService = {
    insertRow: vi.fn().mockResolvedValue(undefined),
  };

  const invoiceRepository = {
    computeDocumentHash: vi.fn().mockReturnValue("hash-abc123"),
    findDuplicateByHash: vi.fn().mockResolvedValue(null),
    findDuplicateByBusinessKey: vi.fn().mockResolvedValue(null),
    buildBusinessKeyFromData: vi.fn().mockReturnValue("bk-1"),
    saveProcessedInvoice: vi.fn().mockResolvedValue(undefined),
  };

  const consortiumRepository = {
    findAllForMatching: vi.fn().mockResolvedValue([
      { id: "c1", canonicalName: "THAMES 647", rawName: "CONSORCIO THAMES 647", cuit: "30-11111111-1", matchNames: null },
    ]),
    findByCanonicalName: vi.fn().mockResolvedValue({
      id: "c1", canonicalName: "THAMES 647", rawName: "CONSORCIO THAMES 647",
      cuit: "30-11111111-1", bank: null, statementsFolderId: null,
    }),
    findActivePeriod: vi.fn().mockResolvedValue({ id: "per1", month: 5, year: 2026 }),
  };

  const providerRepository = {
    findAllForMatching: vi.fn().mockResolvedValue([
      { id: "p1", canonicalName: "TIGRE ASCENSORES S.A.", cuit: "30-65511651-2", matchNames: null, paymentAlias: null },
    ]),
    linkToConsortium: vi.fn().mockResolvedValue(undefined),
  };

  const lspServiceRepository = {
    findByProviderId: vi.fn().mockResolvedValue(null),
    findByProviderName: vi.fn().mockResolvedValue(null),
    setProviderId: vi.fn().mockResolvedValue(undefined),
  };

  const aiChain = {
    run: vi.fn<(text: string, onAttempt?: AiAttemptCallback) => Promise<AiExtractionResult | null>>(
      async (_text, onAttempt) => {
        onAttempt?.("gemini", true);
        return {
          data: okExtraction(),
          usage: { provider: "gemini", model: "flash-lite", inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          provider: "gemini",
        };
      }
    ),
  };

  const resolveStatementsFolders = vi.fn().mockResolvedValue({ periodFolderId: "pf1", consortiumFolderId: "cf1" });
  const buildInvoiceFileName = vi.fn().mockReturnValue("TIGRE - THAMES 647 - 05-2026.pdf");

  return {
    resolvedConfig: config,
    resolvedMapping: DEFAULT_MAPPING,
    driveService,
    pdfExtractor,
    sheetsService,
    invoiceRepository,
    consortiumRepository,
    providerRepository,
    lspServiceRepository,
    geminiModule: null,
    aiChain,
    geminiApiKey: undefined,
    geminiModel: undefined,
    existingDuplicateKeys: new Set<string>(),
    resolveStatementsFolders,
    buildInvoiceFileName,
  };
}

type TestContext = ReturnType<typeof makeContext>;

/** Cast al tipo público (las deps mockeadas implementan solo lo que el pipeline usa). */
function asContext(ctx: TestContext): ProcessingContext {
  return ctx as unknown as ProcessingContext;
}

describe("processDriveFile — caracterización de los 7 caminos de salida", () => {
  let metricsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Silenciar el logging ruidoso del pipeline (console) y capturar [metrics].
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    metricsSpy = vi.spyOn(pipelineLog, "metrics").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Devuelve el `core` de la única línea [metrics] emitida (garantía del finally). */
  function metricsCore(): Record<string, unknown> {
    expect(metricsSpy).toHaveBeenCalledTimes(1);
    return metricsSpy.mock.calls[0][0] as Record<string, unknown>;
  }

  it("ok: inserta en Sheets, guarda Invoice, organiza en Rendiciones", async () => {
    const ctx = makeContext();
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.sheetsService.insertRow).toHaveBeenCalledTimes(1);
    expect(ctx.invoiceRepository.saveProcessedInvoice).toHaveBeenCalledTimes(1);
    // Boleta OK → renombra + mueve a la carpeta de período de Rendiciones.
    expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledWith("file-1", "pending", "pf1");
    expect(summary.processed).toBe(1);
    expect(summary.unassigned).toBe(0);
    expect(metricsCore().result).toBe("ok");
  });

  it("duplicate (hash): no escribe en Sheets ni DB, mueve a Duplicados", async () => {
    const ctx = makeContext();
    ctx.invoiceRepository.findDuplicateByHash.mockResolvedValue({ id: "inv-prev" });
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.sheetsService.insertRow).not.toHaveBeenCalled();
    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledWith("file-1", "pending", "duplicates");
    expect(summary.duplicatesDetected).toBe(1);
    expect(metricsCore().result).toBe("duplicate");
  });

  it("duplicate (business key): no escribe en Sheets ni DB, mueve a Duplicados", async () => {
    const ctx = makeContext();
    ctx.invoiceRepository.findDuplicateByBusinessKey.mockResolvedValue({ id: "inv-prev" });
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.sheetsService.insertRow).not.toHaveBeenCalled();
    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledWith("file-1", "pending", "duplicates");
    expect(summary.duplicatesDetected).toBe(1);
    expect(metricsCore().result).toBe("duplicate");
  });

  it("unassigned: mueve a Sin Asignar, sin Sheets ni DB", async () => {
    const ctx = makeContext();
    ctx.consortiumRepository.findAllForMatching.mockResolvedValue([]); // nada matchea
    ctx.aiChain.run.mockImplementation(async (_t, cb) => {
      cb?.("gemini", true);
      return {
        data: emptyExtraction({ consortium: "CONSORCIO INEXISTENTE 9999", provider: "X", amount: 5000 }),
        usage: null,
        provider: "gemini",
      };
    });
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.driveService.moveFileToUnassigned).toHaveBeenCalledWith("file-1", "pending", "unassigned");
    expect(ctx.sheetsService.insertRow).not.toHaveBeenCalled();
    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(summary.unassigned).toBe(1);
    expect(metricsCore().result).toBe("unassigned");
  });

  it("no_amount: renombra SIN MONTO y mueve a Revisión", async () => {
    const ctx = makeContext();
    ctx.aiChain.run.mockImplementation(async (_t, cb) => {
      cb?.("gemini", true);
      return { data: okExtraction({ amount: null }), usage: null, provider: "gemini" };
    });
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.driveService.renameFile).toHaveBeenCalledTimes(1);
    expect(ctx.driveService.renameFile.mock.calls[0][1]).toMatch(/SIN MONTO/i);
    expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledWith("file-1", "pending", "failed");
    expect(ctx.sheetsService.insertRow).not.toHaveBeenCalled();
    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(summary.unassigned).toBe(1);
    expect(metricsCore().result).toBe("no_amount");
  });

  it("no_period: consorcio matchea pero sin período activo → Revisión", async () => {
    const ctx = makeContext();
    ctx.consortiumRepository.findActivePeriod.mockResolvedValue(null);
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledWith("file-1", "pending", "failed");
    expect(ctx.sheetsService.insertRow).not.toHaveBeenCalled();
    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(summary.unassigned).toBe(1);
    expect(metricsCore().result).toBe("no_period");
  });

  it("rate_limited: 429 en todos los proveedores → vuelve a Pendientes, no falla", async () => {
    const ctx = makeContext({ driveProcessingFolderId: "processing" });
    ctx.aiChain.run.mockImplementation(async (_t, cb) => {
      cb?.("gemini", false, "quota exceeded", true);
      return null;
    });
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    // Devuelve el PDF de Procesando → Pendientes para reintento posterior.
    expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledWith("file-1", "processing", "pending");
    expect(summary.rateLimited).toBe(1);
    expect(summary.failed).toBe(0);
    expect(ctx.sheetsService.insertRow).not.toHaveBeenCalled();
    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(metricsCore().result).toBe("rate_limited");
  });

  it("failed: error genérico → mueve a Revisión y suma a failed", async () => {
    const ctx = makeContext();
    ctx.driveService.downloadFile.mockRejectedValue(new Error("drive boom"));
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.driveService.moveFileToFailed).toHaveBeenCalledWith("file-1", "pending", "failed");
    expect(summary.failed).toBe(1);
    expect(summary.processed).toBe(0);
    expect(metricsCore().result).toBe("failed");
  });

  it("not_boleta (heurística): no llama a la IA, renombra [NO BOLETA] y va a Revisión", async () => {
    const ctx = makeContext();
    // Texto que la heurística clasifica como no-boleta (certificado sin monto).
    ctx.pdfExtractor.extractTextFromPdf.mockResolvedValue(
      "CERTIFICADO DE FUMIGACION Y CONTROL DE PLAGAS - Edificio Thames 647"
    );
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.aiChain.run).not.toHaveBeenCalled();
    expect(ctx.driveService.renameFile.mock.calls[0][1]).toMatch(/\[NO BOLETA\]/);
    expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledWith("file-1", "pending", "failed");
    expect(ctx.sheetsService.insertRow).not.toHaveBeenCalled();
    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(summary.notBoleta).toBe(1);
    expect(metricsCore().result).toBe("not_boleta");
  });

  it("not_boleta (IA): aiChain devuelve isBoleta:false → [NO BOLETA] a Revisión", async () => {
    const ctx = makeContext();
    ctx.aiChain.run.mockImplementation(async (_t, cb) => {
      cb?.("gemini", true);
      return { data: okExtraction({ isBoleta: false }), usage: null, provider: "gemini" };
    });
    const summary = createBaseSummary(1);

    await processDriveFile(makeFile(), asContext(ctx), summary);

    expect(ctx.driveService.renameFile.mock.calls[0][1]).toMatch(/\[NO BOLETA\]/);
    expect(ctx.driveService.moveFileToFolder).toHaveBeenCalledWith("file-1", "pending", "failed");
    expect(ctx.sheetsService.insertRow).not.toHaveBeenCalled();
    expect(ctx.invoiceRepository.saveProcessedInvoice).not.toHaveBeenCalled();
    expect(summary.notBoleta).toBe(1);
    expect(metricsCore().result).toBe("not_boleta");
  });
});
